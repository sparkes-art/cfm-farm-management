 JS
// js/app-state.js
// Central in-memory state for the running session.
// Nothing is persisted to localStorage. State rebuilds from Supabase on each load.
 
import { onSessionChange, dbSelect, closeAllSubscriptions } from './supabase-client.js';
 
const _state = {
  session: null,
  farms: [],
  activeFarm: null,
  activeModule: 'outputs',
};
 
const _listeners = new Map();
 
export function getState() { return { ..._state }; }
 
export function getSession() { return _state.session; }
 
export function getActiveFarm() { return _state.activeFarm; }
 
export function getRole() {
  return _state.session?.profile?.role || null;
}
 
export function canWrite() {
  const role = getRole();
  return role === 'operational' || role === 'admin';
}
 
// ── Subscribe to state slices ────────────────────────────────────────────────
export function on(key, fn) {
  if (!_listeners.has(key)) _listeners.set(key, []);
  _listeners.get(key).push(fn);
  return () => {
    const fns = _listeners.get(key) || [];
    _listeners.set(key, fns.filter(f => f !== fn));
  };
}
 
function _emit(key, value) {
  (_listeners.get(key) || []).forEach(fn => fn(value));
}
 
// ── Session init ─────────────────────────────────────────────────────────────
onSessionChange(async (session) => {
  _state.session = session;
  _emit('session', session);
 
  if (session) {
    await _loadFarms(session);
  } else {
    _state.farms = [];
    _state.activeFarm = null;
    closeAllSubscriptions();
    _emit('farms', []);
    _emit('activeFarm', null);
  }
});
 
async function _loadFarms(session) {
  try {
    const profile = session.profile;
    let params = 'select=*&order=name';
 
    // If farm_access is restricted, filter to those farms only
    if (profile?.farm_access?.length) {
      const ids = profile.farm_access.map(id => `"${id}"`).join(',');
      params += `&id=in.(${ids})`;
    }
 
    const farms = await dbSelect('farms', params);
    _state.farms = farms;
    _emit('farms', farms);
 
    // Auto-select first farm
    if (farms.length && !_state.activeFarm) {
      setActiveFarm(farms[0].id);
    }
  } catch (err) {
    console.error('Failed to load farms:', err);
  }
}
 
export function setActiveFarm(farmId) {
  const farm = _state.farms.find(f => f.id === farmId);
  if (!farm) return;
  _state.activeFarm = farm;
  _emit('activeFarm', farm);
}
 
export function setActiveModule(module) {
  _state.activeModule = module;
  _emit('activeModule', module);
}
 
export function getFarms() { return _state.farms; }
 