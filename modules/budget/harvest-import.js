// modules/budget/harvest-import.js
//
// Upload the manager's cotton picking/ginning summary workbook and upsert it
// straight into harvest_entries — no re-typing what's already on the sheet.
//
// Reads the "Fields-Data" tab, header row 8, field rows starting row 9,
// and stops treating a row as a field the moment column A is blank or
// starts with "Total" (the sheet's subtotal/grand-total rows — currently
// rows 22, 37, 38, but this doesn't hardcode row numbers because a manager
// inserting or deleting a field row would shift them).
//
// Matching key: farm_id + season + paddock_name, resolved in JS against
// what's already loaded (see diffHarvestImport) rather than a database
// ON CONFLICT clause. Re-uploading mid-season updates existing rows for
// fields that changed and leaves everything else untouched; it never
// deletes a row, since a field missing from a partial re-upload just means
// "not re-typed this time," not "no longer exists."

import { dbInsert, dbUpdate } from '../../js/supabase-client.js';
import { getCommodities, getCropTypes, addCropType } from '../../js/commodities.js';
import { getActiveFarm, getSession } from '../../js/app-state.js';
import { toast } from '../../js/ui.js';

// The workbook doesn't carry a commodity name at all — this is always a
// cotton picking sheet, and it reports lint bales (Total 227kg Bales), not
// seed cotton. Matched loosely against whatever your commodity is actually
// called (e.g. "Cotton Lint") rather than hardcoding it, since that's
// account-specific setup, not something the sheet tells us — but "Cotton
// Seed" is excluded, the same way budget.js's own lint-source matching
// already excludes it when picking a commodity for lint-derived rows.
function _findCottonCommodity() {
  const all = getCommodities();
  const matches = all.filter(c => {
    const n = c.name.toLowerCase();
    return n.includes('cotton') && !n.includes('seed');
  });
  if (matches.length === 0) {
    throw new Error('No lint commodity with "Cotton" in the name is set up — add one under Settings → Commodities first.');
  }
  if (matches.length > 1) {
    throw new Error('More than one lint commodity matches "Cotton" (' + matches.map(c => c.name).join(', ') + ') — rename one so the import knows which to use.');
  }
  return matches[0];
}

// The sheet's Crop column carries an "IRR" suffix ("Cotton Lateral IRR")
// that your crop types don't ("Cotton Lateral"). Match loosely — exact
// match first, then either name being a prefix of the other — rather than
// creating a near-duplicate crop type on every import.
function _matchCropType(cropLabel, cropTypes) {
  if (!cropLabel) return { cropType: null, unmatched: false };
  const norm = s => s.toLowerCase().trim();
  const label = norm(cropLabel);
  let match = cropTypes.find(ct => norm(ct.name) === label);
  if (!match) {
    match = cropTypes.find(ct => label.startsWith(norm(ct.name)) || norm(ct.name).startsWith(label));
  }
  return { cropType: match || null, unmatched: !match };
}

const SHEET_NAME = 'Fields-Data';
const FIRST_DATA_ROW = 9; // 1-indexed

// Column indexes (0-indexed) matching the Fields-Data header row.
// If a farm's sheet ever has columns in a different order, adjust here —
// nothing else needs to change.
const COL = {
  FIELD: 0,            // A  Fields
  AREA: 1,              // B  Area (ha)
  CROP: 2,              // C  Crop  (e.g. "Cotton Flood IRR")
  ROTATION: 3,          // D  Crop Rotation
  VARIETY: 4,           // E  Variety
  GIN: 5,                // F  Gin
  PICKING_DATE: 6,      // G  Picking Date
  PICKED_AREA: 8,       // I  Picked Area (ha)
  TOTAL_WEIGHT: 11,      // L  Total Weight (seed cotton, kg — this is "ginned_weight" in the app)
  GINNING_STATUS: 13,    // N  Ginning Status
  BALES: 18,             // S  Total 227kg Bales
};

async function _ensureXLSX() {
  if (window.XLSX) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function _numOrNull(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function _excelSerialToISO(serial) {
  const epoch = new Date(1899, 11, 30);
  const d = new Date(epoch.getTime() + serial * 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function _dateToISO(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') return _excelSerialToISO(raw);
  return null;
}

function _buildSheetNotes(row) {
  const bits = [];
  if (row[COL.GIN]) bits.push('Gin: ' + row[COL.GIN]);
  if (row[COL.GINNING_STATUS]) bits.push('Ginning status: ' + row[COL.GINNING_STATUS]);
  if (row[COL.ROTATION]) bits.push('Prev crop: ' + row[COL.ROTATION]);
  return bits.length ? bits.join(' · ') : null;
}

// Managers sometimes type a note straight into the app (e.g. "16 burnt in
// fire") — an upload must never clobber that. Sheet-derived info is
// appended, not substituted, and only once: re-running the same import
// won't pile up duplicate "Gin: ..." text every time.
function _mergeNotes(existingNotes, sheetNotes) {
  if (!sheetNotes) return existingNotes || null;
  if (!existingNotes) return sheetNotes;
  if (existingNotes.includes(sheetNotes)) return existingNotes;
  return existingNotes + ' · ' + sheetNotes;
}

/**
 * Parse the uploaded workbook into harvest_entries-shaped rows.
 * Does NOT write to the database — call commitHarvestImport() after the
 * user has reviewed the preview.
 *
 * @returns {Promise<{parsed: object[], skippedTotals: string[]}>}
 */
export async function parseHarvestExcel(file, season) {
  await _ensureXLSX();

  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const dataRows = rows.slice(FIRST_DATA_ROW - 1);

  const farm = getActiveFarm();
  if (!farm) throw new Error('No active farm selected.');

  const cotton = _findCottonCommodity();
  const cropTypes = getCropTypes(cotton.id);
  const parsed = [];
  const skippedTotals = [];
  const unmatchedCropTypes = new Set();

  // The fields table isn't the last thing on the sheet — "Production by Seed
  // Wet Date" and other summary tables follow further down, with their own
  // headers and numeric columns that would otherwise be misread as field
  // rows once the subtotal rows are skipped. Two guards stop that: a real
  // field row always has a numeric Area (ha), which those later tables'
  // rows don't; and once we've reached the subtotal rows and then hit a row
  // that isn't a valid field or another subtotal, the fields table is over
  // — stop entirely rather than keep scanning the rest of the sheet.
  let reachedTotals = false;

  for (const row of dataRows) {
    const field = row[COL.FIELD];
    if (field === null || field === undefined || String(field).trim() === '') continue;

    const fieldName = String(field).trim();
    if (fieldName.toLowerCase().startsWith('total')) {
      skippedTotals.push(fieldName);
      reachedTotals = true;
      continue;
    }

    const area = row[COL.AREA];
    if (typeof area !== 'number' || Number.isNaN(area)) {
      if (reachedTotals) break; // past the fields table entirely
      continue; // stray row within the table (rare) — skip, don't stop
    }

    const cropLabel = row[COL.CROP] ? String(row[COL.CROP]).trim() : null;
    const { cropType, unmatched } = _matchCropType(cropLabel, cropTypes);
    if (unmatched) unmatchedCropTypes.add(cropLabel);

    parsed.push({
      farm_id: farm.id,
      season,
      commodity_id: cotton.id,
      crop_type_id: cropType?.id || null,
      paddock_name: fieldName,
      variety: row[COL.VARIETY] ? String(row[COL.VARIETY]).trim() : null,
      harvest_date: _dateToISO(row[COL.PICKING_DATE]),
      area_ha: _numOrNull(row[COL.PICKED_AREA] ?? row[COL.AREA]),
      actual_production: _numOrNull(row[COL.BALES]),
      unit: 'bale',
      ginned_weight: _numOrNull(row[COL.TOTAL_WEIGHT]),
      _sheetNotes: _buildSheetNotes(row), // merged into existing notes at diff time, never overwrites them
      _cropLabel: cropLabel, // kept for the preview only; stripped before writing
    });
  }

  if (!parsed.length) {
    throw new Error('No field rows found on "' + sheetName + '" — check this is the picking summary workbook.');
  }

  // Unmatched crop types are surfaced for the user to resolve (rename an
  // existing crop type, or confirm creating a new one) rather than the
  // import silently guessing and creating a near-duplicate.
  return { parsed, skippedTotals, sheetName, unmatchedCropTypes: [...unmatchedCropTypes] };
}

/**
 * Call after the user has resolved any unmatched crop types (either by
 * picking an existing one to map to, or confirming a brand-new one).
 * Creates any genuinely-new crop types and returns the final write-ready rows.
 */
export async function resolveCropTypes(parsed, resolutions, commodityId) {
  // resolutions: { [cropLabel]: existingCropTypeId | '__new__' }
  const created = {};
  for (const row of parsed) {
    const label = row._cropLabel;
    if (row.crop_type_id || !label) { delete row._cropLabel; continue; }
    const choice = resolutions[label];
    if (!choice) { delete row._cropLabel; continue; }
    if (choice === '__new__') {
      if (!created[label]) created[label] = await addCropType(commodityId, label);
      row.crop_type_id = created[label].id;
    } else {
      row.crop_type_id = choice;
    }
    delete row._cropLabel;
  }
  return parsed;
}

/**
 * Diff parsed rows against what's already in harvest_entries for this
 * farm/season, so the preview can show what will actually change.
 */
export function diffHarvestImport(parsed, existingHarvests) {
  const FIELDS = ['variety', 'harvest_date', 'area_ha', 'actual_production', 'ginned_weight', 'crop_type_id'];
  return parsed.map(row => {
    const existing = existingHarvests.find(h => h.paddock_name === row.paddock_name);
    const sheetNotes = row._sheetNotes;
    delete row._sheetNotes;
    delete row._cropLabel; // internal-only; never written to harvest_entries
    row.notes = _mergeNotes(existing?.notes, sheetNotes);

    if (!existing) return { row, status: 'new', changes: [], existingId: null };
    const changes = FIELDS.filter(f => String(existing[f] ?? '') !== String(row[f] ?? ''));
    if (row.notes !== (existing.notes || null)) changes.push('notes');
    return { row, status: changes.length ? 'update' : 'unchanged', changes, existingId: existing.id };
  });
}

/**
 * Write the diffed rows to Supabase — updating existing rows by id and
 * inserting new ones, the same way every other part of the app writes to
 * harvest_entries. Deliberately avoids a bulk ON CONFLICT upsert: PostgREST
 * requires it to target an exact unique constraint and can throw a raw
 * 23505 on rows that should have matched, which update-or-insert by id
 * (already known from the diff) sidesteps entirely.
 *
 * @param {Array<{row: object, existingId: string|null}>} diffedToWrite
 */
export async function commitHarvestImport(diffedToWrite) {
  let updated = 0, inserted = 0;
  for (const { row, existingId } of diffedToWrite) {
    // Strip internal-only fields defensively, regardless of caller.
    const { _cropLabel, _sheetNotes, ...clean } = row;
    if (existingId) {
      await dbUpdate('harvest_entries', existingId, clean);
      updated++;
    } else {
      clean.created_by = getSession()?.user?.id;
      await dbInsert('harvest_entries', clean);
      inserted++;
    }
  }
  toast(`Imported: ${inserted} new, ${updated} updated`, 'success');
}
