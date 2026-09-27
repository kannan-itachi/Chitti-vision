// Live tool test against the running server (read-only / self-cleaning actions only).
const BASE = 'http://127.0.0.1:8787';
const O = { Origin: 'http://localhost:5173' };
const { token } = await (await fetch(`${BASE}/api/session`, { headers: O })).json();
const call = async (name, args = {}) => {
  const t = Date.now();
  const r = await (await fetch(`${BASE}/api/tools/${name}`, { method: 'POST', headers: { ...O, 'Content-Type': 'application/json', 'x-chitti-token': token }, body: JSON.stringify({ args }) })).json();
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  console.log(`\n■ ${name} ${JSON.stringify(args)} (${secs}s)\n  ${r.success ? '✔' : r.needsConfirmation ? '?' : '✘'} ${r.result?.say || r.prompt || r.error}`);
  return r;
};

// security
const noTok = await fetch(`${BASE}/api/tools/system_status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const evil = await fetch(`${BASE}/api/tools/system_status`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', 'x-chitti-token': token }, body: '{}' });
console.log(`security: no token → ${noTok.status}, foreign origin → ${evil.status}`);

const which = process.argv[2] || 'all';
if (which === 'all' || which === 'system') {
  await call('system_status');
  await call('memory_usage');
  await call('top_processes', { by: 'cpu' });
  await call('disk_usage');
  await call('network_status');
  await call('bluetooth_status'); console.log('  server alive after bluetooth:', (await fetch(BASE + '/api/health').then(r => r.ok).catch(() => false)));
  await call('diagnose_slowness');
}
if (which === 'all' || which === 'files') {
  await call('search_files', { query: 'report' });
  await call('recent_files', { type: 'pdf', limit: 3 });
  await call('search_files', { type: 'docx', folder: 'documents' });
  await call('open_file', { path: 'C:\\Windows\\System32\\notepad.exe' }); // must be refused
  await call('open_folder', { folder: 'C:\\Windows' }); // must be refused
  const mk = await call('create_folder', { name: 'chitti-tool-test', parent: 'documents' });
  if (mk.success) {
    const del = await call('delete_path', { path: mk.result.data.path });
    if (del.needsConfirmation) {
      const r = await (await fetch(`${BASE}/api/tools/confirm`, { method: 'POST', headers: { ...O, 'Content-Type': 'application/json', 'x-chitti-token': token }, body: JSON.stringify({ confirmId: del.confirmId, approved: true }) })).json();
      console.log(`  confirmed → ${r.success ? '✔' : '✘'} ${r.result?.say || r.error}`);
    }
  }
  await call('delete_path', { path: 'documents' }); // protected
}
if (which === 'all' || which === 'maps') {
  await call('geocode', { place: 'Erode' });
  await call('route_info', { from: 'Erode', to: 'Coimbatore' });
  await call('route_info', { from: '11.3410,77.7172', to: 'Chennai', mode: 'driving' });
  await call('nearby_places', { kind: 'hospital', near: '11.3410,77.7172' });
  await call('reverse_geocode', { lat: 11.341, lon: 77.7172 });
}
if (which === 'all' || which === 'web') {
  await call('web_search', { query: 'latest ISRO mission' });
  await call('official_website', { name: 'Indian Railways' });
  await call('youtube_search', { query: 'python tutorials' });
}
if (which === 'screen') {
  await call('active_window');
  const s = await call('analyze_screen');
  console.log(JSON.stringify({ ...s.result?.data, text: s.result?.data?.text?.slice(0, 200), windows: s.result?.data?.windows?.length }, null, 1));
}
