// What counts as dangerous. Sharp objects and weapons engage the red chip; blunt objects
// and fire sources only raise caution. Names match the detector (COCO) and the
// 1000-class classifier (ImageNet, first synonym, lower-case).
const HAZARDS = {
  // sharp / cutting
  knife: 'sharp', scissors: 'sharp', cleaver: 'sharp', 'letter opener': 'sharp', hatchet: 'sharp',
  screwdriver: 'sharp', syringe: 'sharp', 'safety pin': 'sharp', 'can opener': 'sharp', corkscrew: 'sharp',
  'chain saw': 'sharp', nail: 'sharp', scabbard: 'sharp', 'power drill': 'sharp',
  // weapons
  revolver: 'weapon', rifle: 'weapon', 'assault rifle': 'weapon', holster: 'weapon', cannon: 'weapon',
  missile: 'weapon', projectile: 'weapon', bow: 'weapon',
  // blunt / fire → caution only
  'baseball bat': 'blunt', hammer: 'blunt', lighter: 'fire', matchstick: 'fire',
};

export const RED_CHIP_KINDS = new Set(['sharp', 'weapon']);
export const KIND_LABEL = { sharp: 'SHARP OBJECT', weapon: 'WEAPON', blunt: 'BLUNT OBJECT', fire: 'FIRE SOURCE' };

export function hazardOf(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  const kind = HAZARDS[n] || Object.entries(HAZARDS).find(([k]) => n.endsWith(` ${k}`))?.[1];
  return kind ? { kind, name: n } : null;
}

export const isRedChip = (h) => !!h && RED_CHIP_KINDS.has(h.kind);
