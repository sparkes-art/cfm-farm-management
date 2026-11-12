// modules/weather/weather.js
// Seasonal weather module — rainfall and GDD charts, BOM / Open-Meteo data

import { dbSelect } from '../../js/supabase-client.js?v=1794519829423';
import { getActiveFarm, canWrite, getActiveSeason } from '../../js/app-state.js?v=1794519829423';
import { qs } from '../../js/ui.js?v=1794519829423';

export async function mountWeather(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Weather</h1>
        <p class="page-subtitle">${farm?.name || ''}</p>
      </div>
    </div>
    ${!farm ? '<div class="card"><div class="card-body"><p style="color:var(--hint)">No farm selected.</p></div></div>' : ''}
    ${farm && !farm.settings?.latitude ? `
      <div class="card"><div class="card-body" style="padding:20px">
        <p style="color:var(--hint)">No farm coordinates configured. Add latitude and longitude in Farm Settings to enable weather data.</p>
      </div></div>` : ''}
    ${farm && farm.settings?.latitude ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <p style="font-size:12px;color:var(--hint);margin:0">Season-to-date vs 30-year average</p>
        <span style="font-size:11px;color:var(--hint)" id="wx-station-label"></span>
      </div>
      <div id="wx-panel">
        <div style="font-size:11px;color:var(--hint);padding:12px 0">Loading weather data…</div>
      </div>` : ''}
  `;

  if (farm?.settings?.latitude && farm?.settings?.longitude) {
    _loadWeatherPanel(farm, season).catch(e => {
      console.error('[weather panel error]', e.message, e.stack);
      const panel = document.getElementById('wx-panel');
      if (panel) panel.innerHTML = '<div style="font-size:11px;color:var(--hint)">Weather error: ' + e.message + '</div>';
    });
  }
}

async function _loadWeatherPanel(farm, season) {
  const panel = document.getElementById('wx-panel');
  const stationLabel = document.getElementById('wx-station-label');
  if (!panel) return;

  const wx = farm.settings.weather || {};
  const stationId = wx.bomStationId || farm.id;
  const gddBase = wx.gddBase || 10;
  if (stationLabel) stationLabel.textContent = (wx.locationLabel || farm.name) + ' · Open-Meteo';

  // Season year — derive from the active season string (e.g. "2026-27" or "2026")
  const yearStart = farm.settings?.yearStartMonth || 1;
  const now = new Date();
  const seasonStartYear = season ? parseInt(season.split('-')[0]) : null;
  const seasonYear = seasonStartYear || (yearStart === 1 ? now.getFullYear()
    : (now.getMonth() + 1 >= yearStart ? now.getFullYear() : now.getFullYear() - 1));
  const startDate = `${seasonYear}-${String(yearStart).padStart(2,'0')}-01`;
  const endDate = yearStart === 1
    ? `${seasonYear}-12-31`
    : `${seasonYear + 1}-${String(yearStart - 1).padStart(2,'0')}-${new Date(seasonYear+1, yearStart-1, 0).getDate()}`;

  const [obsRows, overrideRows, avgRows] = await Promise.all([
    dbSelect('weather_observations',
      `farm_id=eq.${farm.id}&station_id=eq.${stationId}&obs_date=gte.${startDate}&obs_date=lte.${endDate}&order=obs_date.asc&limit=500`
    ).catch(() => []),
    dbSelect('weather_monthly_overrides',
      `farm_id=eq.${farm.id}&year=gte.${seasonYear}&year=lte.${seasonYear+1}&order=year.asc,month.asc`
    ).catch(() => []),
    dbSelect('weather_station_averages',
      `station_id=eq.${stationId}&order=month.asc`
    ).catch(() => []),
  ]);

  // Build full 12-month array
  const allMonths = [];
  for (let i = 0; i < 12; i++) {
    let mo = yearStart + i; let yr = seasonYear;
    if (mo > 12) { mo -= 12; yr++; }
    const monthKey = `${yr}-${String(mo).padStart(2,'0')}`;
    const monthObs = obsRows.filter(r => r.obs_date.startsWith(monthKey));
    const override = overrideRows.find(r => r.year === yr && r.month === mo);
    const isFuture = new Date(yr, mo - 1, 1) > now && seasonYear === (seasonStartYear || now.getFullYear());

    const actualRain = override
      ? { value: parseFloat(override.rainfall_mm), source: 'gauge' }
      : { value: monthObs.reduce((s, r) => s + (parseFloat(r.rainfall_mm) || 0), 0), source: monthObs.length ? 'BOM' : null };

    const gdd = monthObs.reduce((s, r) => {
      const avg = ((parseFloat(r.temp_max) || 0) + (parseFloat(r.temp_min) || 0)) / 2;
      return s + Math.max(0, avg - gddBase);
    }, 0);

    const lta = avgRows.find(a => a.month === mo);

    allMonths.push({
      label: new Date(yr, mo - 1, 1).toLocaleDateString('en-AU', { month: 'short' }),
      month: mo, year: yr, isFuture,
      rain: isFuture ? null : Math.round(actualRain.value * 10) / 10,
      rainSource: isFuture ? null : (override ? 'gauge' : (monthObs.length ? 'BOM' : null)),
      gdd: isFuture ? null : Math.round(gdd),
      ltaRain: lta?.avg_rainfall_mm ? parseFloat(lta.avg_rainfall_mm) : null,
      ltaTempMax: lta?.avg_temp_max ? parseFloat(lta.avg_temp_max) : null,
      ltaTempMin: lta?.avg_temp_min ? parseFloat(lta.avg_temp_min) : null,
      hasData: monthObs.length > 0 || !!override,
    });
  }

  const pastMonths = allMonths.filter(m => !m.isFuture);
  const totalRain = pastMonths.reduce((s, m) => s + (m.rain || 0), 0);
  const totalGDD  = pastMonths.reduce((s, m) => s + (m.gdd  || 0), 0);
  const ltaToDate = pastMonths.reduce((s, m) => s + (m.ltaRain || 0), 0);
  const rainVar   = ltaToDate ? totalRain - ltaToDate : null;
  const rainVarColor = rainVar == null ? '#64748b' : rainVar >= 0 ? '#16a34a' : '#dc2626';
  const hasData   = pastMonths.some(m => m.hasData);

  let cumRain = 0, cumLTA = 0;
  const cumActual = allMonths.map(m => {
    if (!m.isFuture && m.rain !== null) cumRain += m.rain;
    return m.isFuture ? null : Math.round(cumRain);
  });
  const cumAvg = allMonths.map(m => {
    if (m.ltaRain !== null) cumLTA += m.ltaRain;
    return Math.round(cumLTA);
  });

  const todayStr = now.toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const todayObs = obsRows.find(r => r.obs_date === yesterdayStr) || obsRows.find(r => r.obs_date === todayStr);

  const curMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const curMonthObs = obsRows.filter(r => r.obs_date.startsWith(curMonthKey));
  const curOverride = overrideRows.find(r => r.year === now.getFullYear() && r.month === now.getMonth()+1);

  const prevDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const prevMonthKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}`;
  const prevMonthObs = obsRows.filter(r => r.obs_date.startsWith(prevMonthKey));
  const prevOverride = overrideRows.find(r => r.year === prevDate.getFullYear() && r.month === prevDate.getMonth()+1);

  const curMonthRain = curOverride ? parseFloat(curOverride.rainfall_mm)
    : curMonthObs.reduce((s,r) => s+(parseFloat(r.rainfall_mm)||0), 0);
  const prevMonthRain = prevOverride ? parseFloat(prevOverride.rainfall_mm)
    : prevMonthObs.reduce((s,r) => s+(parseFloat(r.rainfall_mm)||0), 0);

  const curMaxTemp  = curMonthObs.length ? Math.max(...curMonthObs.map(r => parseFloat(r.temp_max)||0)) : null;
  const curMinTemp  = curMonthObs.length ? Math.min(...curMonthObs.map(r => parseFloat(r.temp_min)||99)) : null;
  const prevMaxTemp = prevMonthObs.length ? Math.max(...prevMonthObs.map(r => parseFloat(r.temp_max)||0)) : null;
  const prevMinTemp = prevMonthObs.length ? Math.min(...prevMonthObs.map(r => parseFloat(r.temp_min)||99)) : null;

  const curLabel  = now.toLocaleDateString('en-AU', { month: 'short' });
  const prevLabel = prevDate.toLocaleDateString('en-AU', { month: 'short' });

  const n = allMonths.length;
  const barGap = 2;

  let gcum = 0, gltacum = 0;
  const gddCumActual = allMonths.map(m => {
    if (!m.isFuture && m.gdd !== null) gcum += m.gdd;
    return m.isFuture ? null : gcum;
  });
  const gddCumLTA = allMonths.map(m => {
    if (m.ltaTempMax !== null && m.ltaTempMin !== null) {
      const days = new Date(m.year, m.month, 0).getDate();
      gltacum += Math.max(0, ((m.ltaTempMax + m.ltaTempMin) / 2 - gddBase) * days);
    }
    return Math.round(gltacum);
  });

  panel.innerHTML = `
    <!-- Snapshot strip -->
    <div style="background:var(--page-bg);border-radius:8px;padding:8px 12px;margin-bottom:8px;border:0.5px solid var(--border)">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">Weather snapshot</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px">
        ${[
          { label:'Yesterday', rain: todayObs ? parseFloat(todayObs.rainfall_mm) : null, tmax: todayObs ? parseFloat(todayObs.temp_max) : null, tmin: todayObs ? parseFloat(todayObs.temp_min) : null, gauge: false },
          { label: curLabel + ' total', rain: curMonthRain, tmax: curMaxTemp, tmin: curMinTemp, gauge: !!curOverride },
          { label: prevLabel + ' total', rain: prevMonthRain, tmax: prevMaxTemp, tmin: prevMinTemp, gauge: !!prevOverride },
        ].map(s => `
          <div style="padding:6px 8px;background:var(--surface-2);border-radius:6px;border:0.5px solid var(--border)">
            <div style="font-size:9px;font-weight:600;color:var(--hint);margin-bottom:4px">${s.label}${s.gauge ? ' <span style="color:#16a34a">●</span>' : ''}</div>
            <div style="font-size:13px;font-weight:700;color:var(--ink)">${s.rain != null ? Math.round(s.rain*10)/10 + 'mm' : '—'}</div>
            <div style="display:flex;gap:8px;margin-top:2px">
              <span style="font-size:11px;color:#dc2626">${s.tmax != null ? Math.round(s.tmax)+'° max' : '—'}</span>
              <span style="font-size:11px;color:#3b82f6">${s.tmin != null ? Math.round(s.tmin)+'° min' : '—'}</span>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Rainfall card -->
    <div class="card" style="padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Rainfall YTD</span>
          <span style="font-size:18px;font-weight:700;color:var(--ink)">${Math.round(totalRain)}mm</span>
          ${rainVar != null ? `<span style="font-size:11px;font-weight:600;color:${rainVarColor}">${rainVar >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(rainVar))}mm vs 30yr avg (${Math.round(ltaToDate)}mm)</span>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary" id="wx-expand-rain" style="font-size:10px;padding:3px 8px" title="Expand chart">⤢</button>
          ${canWrite() ? `<button class="btn btn-secondary" id="wx-override-btn" style="font-size:10px;padding:3px 8px">✎ Override</button>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:10px;font-size:10px;color:var(--hint);margin-bottom:6px;flex-wrap:wrap">
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#2a78d6;vertical-align:middle;margin-right:3px"></span>Actual (Open-Meteo)</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#16a34a;vertical-align:middle;margin-right:3px"></span>Gauge override</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#d3d1c7;vertical-align:middle;margin-right:3px"></span>30yr avg</span>
        <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3" style="display:block"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#2a78d6" stroke-width="1.5"/></svg>Cumulative</span>
        <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3" style="display:block"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="3,2"/></svg>LTA cumulative</span>
      </div>

      ${hasData ? (() => {
        const VW = 600, VH = 160;
        const P = { top: 10, right: 48, bottom: 20, left: 38 };
        const CW = VW - P.left - P.right;
        const CH = VH - P.top - P.bottom;
        const BW = Math.floor(CW / n) - barGap;
        const maxM = Math.max(...allMonths.map(m => Math.max(m.rain||0, m.ltaRain||0)), 20);
        const maxC = Math.max(...cumAvg, ...cumActual.filter(v=>v!==null), 10);
        const bx = i => P.left + Math.round((i/n)*CW) + 1;
        const by = v => Math.round((v/maxM)*CH);
        const cy = v => P.top + CH - Math.round((v/maxC)*CH);
        const lx = i => bx(i) + BW/2;

        const leftTicks = [0, Math.round(maxM*0.5), Math.round(maxM)];
        const rightTicks = [0, Math.round(maxC*0.5), Math.round(maxC)];

        return `<svg viewBox="0 0 ${VW} ${VH}" style="width:100%;height:${VH}px">
          ${leftTicks.map(v => {
            const y = P.top + CH - by(v);
            return `<line x1="${P.left}" y1="${y}" x2="${P.left+CW}" y2="${y}" stroke="#e8e7e0" stroke-width="0.5"/>
              <text x="${P.left-3}" y="${y+3}" font-size="8" text-anchor="end" fill="#888781">${v}</text>`;
          }).join('')}
          ${rightTicks.map(v => {
            const y = cy(v);
            return `<text x="${P.left+CW+3}" y="${y+3}" font-size="8" text-anchor="start" fill="#2a78d6">${v}</text>`;
          }).join('')}
          <text x="${P.left-26}" y="${P.top+CH/2}" font-size="8" text-anchor="middle" fill="#888781" transform="rotate(-90,${P.left-26},${P.top+CH/2})">mm/mo</text>
          <text x="${P.left+CW+38}" y="${P.top+CH/2}" font-size="8" text-anchor="middle" fill="#2a78d6" transform="rotate(90,${P.left+CW+38},${P.top+CH/2})">cum mm</text>
          ${allMonths.map((m,i) => {
            if (!m.ltaRain) return '';
            const x = bx(i); const h = Math.max(1,by(m.ltaRain));
            const barHalf = Math.ceil(BW/2);
            return `<rect x="${x+BW-barHalf}" y="${P.top+CH-h}" width="${barHalf}" height="${h}" fill="#d3d1c7" rx="1"/>`;
          }).join('')}
          ${allMonths.map((m,i) => {
            if (m.isFuture || m.rain===null) return '';
            const x = bx(i); const h = Math.max(m.rain>0?2:0, by(m.rain));
            const col = m.rainSource==='gauge' ? '#16a34a' : '#2a78d6';
            return `<rect x="${x}" y="${P.top+CH-h}" width="${Math.ceil(BW/2)}" height="${h}" fill="${col}" rx="1"/>`;
          }).join('')}
          ${allMonths.map((m,i) => `<text x="${lx(i)}" y="${P.top+CH+13}" font-size="8" text-anchor="middle" fill="${m.isFuture?'#c8c6be':'#888781'}">${m.label}</text>`).join('')}
          <polyline points="${cumAvg.map((v,i)=>`${lx(i)},${cy(v)}`).join(' ')}"
            fill="none" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="4,3" stroke-linejoin="round"/>
          <polyline points="${cumActual.map((v,i)=>v!==null?`${lx(i)},${cy(v)}`:null).filter(Boolean).join(' ')}"
            fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round"/>
          <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
          <line x1="${P.left}" y1="${P.top+CH}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
          <line x1="${P.left+CW}" y1="${P.top}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
        </svg>`;
      })() : '<div style="font-size:11px;color:var(--hint);padding:12px 0">No data yet</div>'}
    </div>

    <!-- GDD card -->
    <div class="card" style="padding:12px 14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Heat units (GDD)</span>
          <span style="font-size:18px;font-weight:700;color:var(--ink)">${totalGDD.toLocaleString()}</span>
          ${(() => {
            const ltaAtNow = gddCumLTA[pastMonths.length - 1];
            if (!ltaAtNow) return '';
            const diff = totalGDD - ltaAtNow;
            const col = diff >= 0 ? '#16a34a' : '#d97706';
            return `<span style="font-size:11px;font-weight:600;color:${col}">${diff>=0?'▲':'▼'} ${Math.abs(diff)} vs 30yr avg (${ltaAtNow})</span>`;
          })()}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="display:flex;gap:10px;font-size:10px;color:var(--hint)">
            <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3" style="display:block"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#eb6834" stroke-width="2"/></svg>${seasonYear} actual</span>
            ${gddCumLTA.some(v=>v>0) ? '<span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3" style="display:block"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="3,2"/></svg>30yr avg</span>' : ''}
          </div>
          <button class="btn btn-secondary" id="wx-expand-gdd" style="font-size:10px;padding:3px 8px" title="Expand chart">⤢</button>
        </div>
      </div>
      <div style="font-size:10px;color:var(--hint);margin-bottom:6px">Base ${gddBase}°C · cumulative from ${new Date(seasonYear, yearStart-1, 1).toLocaleDateString('en-AU',{month:'short',year:'numeric'})}</div>

      ${hasData ? (() => {
        const VW = 600, VH = 160;
        const P = { top: 10, right: 16, bottom: 20, left: 42 };
        const CW = VW - P.left - P.right;
        const CH = VH - P.top - P.bottom;
        const maxG = Math.max(...gddCumActual.filter(v=>v!==null), ...gddCumLTA, 1);
        const gx = i => P.left + Math.round((i/(n-1))*CW);
        const gy = v => P.top + CH - Math.round((v/maxG)*CH);
        const ticks = [0, Math.round(maxG*0.25), Math.round(maxG*0.5), Math.round(maxG*0.75), Math.round(maxG)];

        return `<svg viewBox="0 0 ${VW} ${VH}" style="width:100%;height:${VH}px">
          ${ticks.map(v => {
            const y = gy(v);
            return `<line x1="${P.left}" y1="${y}" x2="${P.left+CW}" y2="${y}" stroke="#e8e7e0" stroke-width="0.5"/>
              <text x="${P.left-4}" y="${y+3}" font-size="8" text-anchor="end" fill="#888781">${v}</text>`;
          }).join('')}
          ${allMonths.map((m,i) => `<text x="${gx(i)}" y="${P.top+CH+13}" font-size="8" text-anchor="middle" fill="${m.isFuture?'#c8c6be':'#888781'}">${m.label}</text>`).join('')}
          ${gddCumLTA.some(v=>v>0) ? `<polyline points="${gddCumLTA.map((v,i)=>`${gx(i)},${gy(v)}`).join(' ')}"
            fill="none" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="4,3" stroke-linejoin="round"/>` : ''}
          <polyline points="${gddCumActual.map((v,i)=>v!==null?`${gx(i)},${gy(v)}`:null).filter(Boolean).join(' ')}"
            fill="none" stroke="#eb6834" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
          ${(() => {
            const idx = gddCumActual.map((v,i)=>v!==null?i:-1).filter(i=>i>=0).pop();
            if (idx==null) return '';
            return `<circle cx="${gx(idx)}" cy="${gy(gddCumActual[idx])}" r="3.5" fill="#eb6834"/>`;
          })()}
          <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
          <line x1="${P.left}" y1="${P.top+CH}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
        </svg>`;
      })() : '<div style="font-size:11px;color:var(--hint)">No temperature data yet — re-seed averages to show LTA comparison</div>'}
    </div>`;

  document.getElementById('wx-expand-rain')?.addEventListener('click', () => {
    _openWeatherExpandModal('rainfall', farm, allMonths, cumActual, cumAvg, totalRain, ltaToDate, rainVar, rainVarColor, seasonYear, n);
  });

  document.getElementById('wx-expand-gdd')?.addEventListener('click', () => {
    _openWeatherExpandModal('gdd', farm, allMonths, gddCumActual, gddCumLTA, totalGDD, gddCumLTA[pastMonths.length-1], null, null, seasonYear, n);
  });
}

function _openWeatherExpandModal(type, farm, allMonths, actualData, ltaData, total, ltaTotal, varVal, varColor, seasonYear, n) {
  const isRain = type === 'rainfall';
  const title = isRain ? 'Rainfall — season to date' : 'Heat units (GDD) — cumulative';
  const wx = farm.settings?.weather || {};
  const subtitle = `${wx.locationLabel || farm.name} · ${seasonYear} vs 30-year average`;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';

  const VW = 800, VH = isRain ? 320 : 280;
  const P = { top: 16, right: isRain ? 60 : 20, bottom: 28, left: 50 };
  const CW = VW - P.left - P.right;
  const CH = VH - P.top - P.bottom;
  const barGap = 2;

  let chartSvg = '';

  if (isRain) {
    const pastMonths = allMonths.filter(m => !m.isFuture);
    const maxM = Math.max(...allMonths.map(m => Math.max(m.rain||0, m.ltaRain||0)), 20);
    const maxC = Math.max(...(ltaData||[]), ...(actualData||[]).filter(v=>v!==null), 10);
    const BW = Math.floor(CW / n) - barGap;
    const bx = i => P.left + Math.round((i/n)*CW) + 1;
    const by = v => Math.round((v/maxM)*CH);
    const cy = v => P.top + CH - Math.round((v/maxC)*CH);
    const lx = i => bx(i) + BW/2;
    const leftTicks = [0, Math.round(maxM*0.5), Math.round(maxM)];
    const rightTicks = [0, Math.round(maxC*0.5), Math.round(maxC)];

    chartSvg = `<svg viewBox="0 0 ${VW} ${VH}" style="width:100%;height:${VH}px">
      ${leftTicks.map(v => {
        const y = P.top + CH - by(v);
        return `<line x1="${P.left}" y1="${y}" x2="${P.left+CW}" y2="${y}" stroke="#e8e7e0" stroke-width="0.5"/>
          <text x="${P.left-4}" y="${y+3}" font-size="9" text-anchor="end" fill="#888781">${v}mm</text>`;
      }).join('')}
      ${rightTicks.map(v => {
        const y = cy(v);
        return `<text x="${P.left+CW+4}" y="${y+3}" font-size="9" text-anchor="start" fill="#2a78d6">${v}mm</text>`;
      }).join('')}
      ${allMonths.map((m,i) => {
        const ltaH = m.ltaRain ? Math.max(1,by(m.ltaRain)) : 0;
        const rainH = m.isFuture||m.rain===null ? 0 : Math.max(m.rain>0?2:0,by(m.rain));
        const col = m.rainSource==='gauge' ? '#16a34a' : '#2a78d6';
        const x = bx(i);
        return `${ltaH ? `<rect x="${x+Math.ceil(BW/2)}" y="${P.top+CH-ltaH}" width="${Math.ceil(BW/2)}" height="${ltaH}" fill="#d3d1c7" rx="1"/>` : ''}
          ${rainH ? `<rect x="${x}" y="${P.top+CH-rainH}" width="${Math.ceil(BW/2)}" height="${rainH}" fill="${col}" rx="1"/>` : ''}
          <text x="${lx(i)}" y="${P.top+CH+16}" font-size="9" text-anchor="middle" fill="${m.isFuture?'#c8c6be':'#888781'}">${m.label}</text>`;
      }).join('')}
      <polyline points="${(ltaData||[]).map((v,i)=>`${lx(i)},${cy(v)}`).join(' ')}"
        fill="none" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="5,3" stroke-linejoin="round"/>
      <polyline points="${(actualData||[]).map((v,i)=>v!==null?`${lx(i)},${cy(v)}`:null).filter(Boolean).join(' ')}"
        fill="none" stroke="#2a78d6" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
      <line x1="${P.left}" y1="${P.top+CH}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
      <line x1="${P.left+CW}" y1="${P.top}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
    </svg>`;
  } else {
    const maxG = Math.max(...(actualData||[]).filter(v=>v!==null), ...(ltaData||[]), 1);
    const gx = i => P.left + Math.round((i/(n-1))*CW);
    const gy = v => P.top + CH - Math.round((v/maxG)*CH);
    const ticks = [0,0.25,0.5,0.75,1].map(f => Math.round(maxG*f));

    chartSvg = `<svg viewBox="0 0 ${VW} ${VH}" style="width:100%;height:${VH}px">
      ${ticks.map(v => {
        const y = gy(v);
        return `<line x1="${P.left}" y1="${y}" x2="${P.left+CW}" y2="${y}" stroke="#e8e7e0" stroke-width="0.5"/>
          <text x="${P.left-4}" y="${y+3}" font-size="9" text-anchor="end" fill="#888781">${v}</text>`;
      }).join('')}
      ${allMonths.map((m,i) => `<text x="${gx(i)}" y="${P.top+CH+16}" font-size="9" text-anchor="middle" fill="${m.isFuture?'#c8c6be':'#888781'}">${m.label}</text>`).join('')}
      ${(ltaData||[]).some(v=>v>0) ? `<polyline points="${(ltaData||[]).map((v,i)=>`${gx(i)},${gy(v)}`).join(' ')}"
        fill="none" stroke="#b4b2a9" stroke-width="2" stroke-dasharray="5,3" stroke-linejoin="round"/>` : ''}
      <polyline points="${(actualData||[]).map((v,i)=>v!==null?`${gx(i)},${gy(v)}`:null).filter(Boolean).join(' ')}"
        fill="none" stroke="#eb6834" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${(() => {
        const idx = (actualData||[]).map((v,i)=>v!==null?i:-1).filter(i=>i>=0).pop();
        if (idx==null) return '';
        return `<circle cx="${gx(idx)}" cy="${gy(actualData[idx])}" r="5" fill="#eb6834"/>
          <text x="${gx(idx)+8}" y="${gy(actualData[idx])+4}" font-size="10" fill="#eb6834" font-weight="bold">${actualData[idx]}</text>`;
      })()}
      <line x1="${P.left}" y1="${P.top}" x2="${P.left}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
      <line x1="${P.left}" y1="${P.top+CH}" x2="${P.left+CW}" y2="${P.top+CH}" stroke="#c3c2b7" stroke-width="0.5"/>
    </svg>`;
  }

  const diff = varVal != null ? (isRain ? Math.abs(Math.round(varVal)) + 'mm' : Math.abs(Math.round(total - ltaTotal))) : null;
  const diffColor = isRain ? varColor : (total >= ltaTotal ? '#16a34a' : '#d97706');
  const diffDir = isRain ? (varVal >= 0 ? '▲' : '▼') : (total >= ltaTotal ? '▲' : '▼');

  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:860px;max-height:92vh;overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.35)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${title}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${subtitle}</div>
        </div>
        <div style="display:flex;align-items:center;gap:16px">
          <div style="text-align:right">
            <div style="font-size:22px;font-weight:700;color:var(--ink)">${isRain ? Math.round(total)+'mm' : total.toLocaleString()}</div>
            ${diff ? `<div style="font-size:12px;font-weight:600;color:${diffColor}">${diffDir} ${diff} vs 30yr avg</div>` : ''}
          </div>
          <button id="wx-expand-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--hint);padding:4px">✕</button>
        </div>
      </div>
      <div style="padding:20px">
        ${chartSvg}
        <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:var(--hint);flex-wrap:wrap">
          ${isRain ? `
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#2a78d6;vertical-align:middle;margin-right:3px"></span>Actual (Open-Meteo)</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#16a34a;vertical-align:middle;margin-right:3px"></span>Gauge override</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#d3d1c7;vertical-align:middle;margin-right:3px"></span>30yr avg monthly</span>
          <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#2a78d6" stroke-width="2"/></svg>Cumulative actual</span>
          <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="4,2"/></svg>LTA cumulative</span>
          ` : `
          <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#eb6834" stroke-width="2.5"/></svg>${seasonYear} actual</span>
          <span style="display:inline-flex;align-items:center;gap:3px"><svg width="16" height="3"><line x1="0" y1="1.5" x2="16" y2="1.5" stroke="#b4b2a9" stroke-width="1.5" stroke-dasharray="4,2"/></svg>30yr average</span>
          `}
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#wx-expand-close').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
}
