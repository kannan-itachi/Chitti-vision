// Real system telemetry via the `systeminformation` package and Node's os module.
// Nothing here is estimated or invented: if a value can't be read it is reported as unavailable.
import os from 'node:os';
import dns from 'node:dns/promises';
import si from 'systeminformation';
import { define } from './registry.js';

const GB = 1024 ** 3;
const gb = (b) => `${(b / GB).toFixed(1)} GB`;
const pct = (x) => `${Math.round(x)}%`;
const dur = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d} day${d > 1 ? 's' : ''}`, h && `${h} hour${h > 1 ? 's' : ''}`, `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
};

// Two independent DNS lookups with a generous timeout: a busy PC can be slow to resolve,
// and one failing host should not report the whole machine as offline.
async function online() {
  const probe = (host) => Promise.race([dns.lookup(host), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]);
  try {
    await Promise.any([probe('wikipedia.org'), probe('cloudflare.com')]);
    return true;
  } catch {
    return false;
  }
}

async function disks() {
  const fs = await si.fsSize();
  return fs.filter((d) => d.size > 1e9).map((d) => ({ drive: d.mount, size: d.size, used: d.used, free: d.available ?? d.size - d.used, usePct: d.use }));
}

// Group processes by name so "chrome" shows as one app, not 30 helper processes.
async function topProcesses(by = 'memory', limit = 5) {
  const { list } = await si.processes();
  const groups = new Map();
  for (const p of list) {
    const name = p.name.replace(/\.exe$/i, '');
    if (!name || name === 'System Idle Process') continue;
    const g = groups.get(name) || { name, memory: 0, cpu: 0, count: 0 };
    g.memory += p.memRss * 1024;
    g.cpu += p.cpu;
    g.count++;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu : b.memory - a.memory)).slice(0, limit);
}

define({
  name: 'system_status',
  category: 'SYSTEM',
  description: 'Current computer status: CPU load, RAM, disks, battery, network, OS, uptime, GPU.',
  async run() {
    const [load, mem, dsk, bat, osInfo, gfx, temp, net] = await Promise.all([
      si.currentLoad(), si.mem(), disks(), si.battery(), si.osInfo(), si.graphics().catch(() => ({ controllers: [] })),
      si.cpuTemperature().catch(() => ({})), online(),
    ]);
    const cpu = os.cpus()[0]?.model?.replace(/\s+/g, ' ').trim();
    const memUsed = mem.total - mem.available;
    const data = {
      cpu: { model: cpu, cores: os.cpus().length, loadPct: Math.round(load.currentLoad) },
      memory: { total: mem.total, used: memUsed, usePct: Math.round((memUsed / mem.total) * 100) },
      disks: dsk,
      battery: bat.hasBattery ? { percent: bat.percent, charging: bat.isCharging } : null,
      os: `${osInfo.distro} ${osInfo.release} (${osInfo.arch})`,
      uptime: os.uptime(),
      gpu: gfx.controllers.map((g) => g.model).filter(Boolean),
      temperature: Number.isFinite(temp.main) && temp.main > 0 ? temp.main : null,
      online: net,
    };
    const main = dsk.find((d) => /^C:/i.test(d.drive)) || dsk[0];
    const say = [
      `CPU at ${pct(data.cpu.loadPct)}, memory ${pct(data.memory.usePct)} used (${gb(memUsed)} of ${gb(mem.total)}).`,
      main && `Drive ${main.drive} has ${gb(main.free)} free of ${gb(main.size)}.`,
      data.battery && `Battery ${data.battery.percent}%${data.battery.charging ? ', charging' : ''}.`,
      `${net ? 'Internet connected' : 'No internet connection'}. Up for ${dur(data.uptime)}.`,
      data.temperature ? `CPU temperature ${Math.round(data.temperature)} degrees.` : null,
    ].filter(Boolean).join(' ');
    return { say, data };
  },
});

define({
  name: 'memory_usage',
  category: 'SYSTEM',
  description: 'How much RAM is used, and which apps are using the most memory.',
  async run() {
    const [mem, top] = await Promise.all([si.mem(), topProcesses('memory', 5)]);
    const used = mem.total - mem.available;
    const list = top.map((p) => `${p.name} ${gb(p.memory)}`).join(', ');
    return { say: `You are using ${gb(used)} of ${gb(mem.total)} RAM, ${pct((used / mem.total) * 100)}. Biggest users: ${list}.`, data: { total: mem.total, used, top } };
  },
});

define({
  name: 'top_processes',
  category: 'SYSTEM',
  description: 'List the apps/processes using the most CPU or memory.',
  params: { by: { type: 'string', enum: ['cpu', 'memory'], description: 'sort by cpu or memory' } },
  async run({ by = 'memory' }) {
    if (by === 'cpu') await si.currentLoad(); // prime the CPU sampler
    const top = await topProcesses(by, 6);
    const list = top.map((p) => (by === 'cpu' ? `${p.name} ${p.cpu.toFixed(1)}%` : `${p.name} ${gb(p.memory)}`)).join(', ');
    return { say: `Top ${by === 'cpu' ? 'CPU' : 'memory'} users: ${list}.`, data: top };
  },
});

define({
  name: 'disk_usage',
  category: 'SYSTEM',
  description: 'Free and used storage on each drive.',
  async run() {
    const d = await disks();
    const say = d.map((x) => `${x.drive} ${gb(x.free)} free of ${gb(x.size)}${x.usePct > 90 ? ', almost full' : ''}`).join('. ');
    return { say: `${say}.`, data: d };
  },
});

define({
  name: 'network_status',
  category: 'SYSTEM',
  description: 'Internet connectivity, Wi-Fi network and signal, local IP address.',
  async run() {
    const [net, wifi, ifaces] = await Promise.all([online(), si.wifiConnections().catch(() => []), si.networkInterfaces()]);
    const active = (Array.isArray(ifaces) ? ifaces : [ifaces]).find((i) => i.default) || null;
    const w = wifi[0];
    const say = [
      net ? 'You are online.' : 'You are offline.',
      w ? `Connected to Wi-Fi "${w.ssid}" with ${w.quality ?? '?'}% signal.` : 'No Wi-Fi connection detected.',
      active?.ip4 ? `Local IP ${active.ip4}.` : null,
    ].filter(Boolean).join(' ');
    return { say, data: { online: net, wifi: w ? { ssid: w.ssid, quality: w.quality, security: w.security } : null, interface: active && { name: active.ifaceName, ip4: active.ip4, type: active.type } } };
  },
});

define({
  name: 'bluetooth_status',
  category: 'SYSTEM',
  description: 'Paired and connected Bluetooth devices.',
  async run() {
    const devices = await si.bluetoothDevices().catch(() => null);
    if (!devices) return { say: 'I could not read Bluetooth information on this computer.', data: null };
    const connected = devices.filter((d) => d.connected);
    return {
      say: devices.length ? `${devices.length} Bluetooth device${devices.length > 1 ? 's' : ''} known${connected.length ? `, connected: ${connected.map((d) => d.name).join(', ')}` : ', none connected'}.` : 'No Bluetooth devices found.',
      data: devices.map((d) => ({ name: d.name, connected: d.connected, type: d.type })),
    };
  },
});

define({
  name: 'diagnose_slowness',
  category: 'SYSTEM',
  description: 'Explain why the computer might be slow (CPU, RAM, disk, heavy apps).',
  async run() {
    const [load, mem, dsk] = await Promise.all([si.currentLoad(), si.mem(), disks()]);
    const [byCpu, byMem] = await Promise.all([topProcesses('cpu', 3), topProcesses('memory', 3)]);
    const memPct = ((mem.total - mem.available) / mem.total) * 100;
    const findings = [];
    if (load.currentLoad > 80) findings.push(`CPU is very busy at ${pct(load.currentLoad)}, mostly ${byCpu.map((p) => p.name).join(', ')}.`);
    if (memPct > 85) findings.push(`Memory is nearly full at ${pct(memPct)}. ${byMem.map((p) => `${p.name} uses ${gb(p.memory)}`).join(', ')}.`);
    for (const d of dsk) if (d.usePct > 90) findings.push(`Drive ${d.drive} is ${pct(d.usePct)} full, which slows Windows down.`);
    const say = findings.length
      ? `${findings.join(' ')} Closing heavy apps${dsk.some((d) => d.usePct > 90) ? ' and freeing disk space' : ''} should help.`
      : `Nothing looks overloaded right now: CPU ${pct(load.currentLoad)}, memory ${pct(memPct)}. The heaviest app is ${byMem[0]?.name} at ${gb(byMem[0]?.memory || 0)}.`;
    return { say, data: { cpu: load.currentLoad, memPct, disks: dsk, byCpu, byMem } };
  },
});
