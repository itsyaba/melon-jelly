// Varieties, in linear RGB.
// `flesh` is a TRANSMISSION colour (fraction of each channel surviving a unit path);
// `fleshDeep` is the SCATTERED albedo. Keeping them apart is what makes the jelly
// deep red where thick and bright at thin edges.

export const PALETTES = {
  crimson: {
    name: 'Crimson',
    flesh: [0.93, 0.07, 0.11], fleshDeep: [0.42, 0.018, 0.035],
    pale: [0.8, 0.86, 0.62], skin: [0.03, 0.13, 0.035], stripe: [0.005, 0.034, 0.01],
    seed: [0.01, 0.0065, 0.005], shadowTint: [0.6, 0.47, 0.46],
    ui: { flesh: [0.62, 0.03, 0.06] },
  },
  golden: {
    name: 'Golden',
    flesh: [0.97, 0.52, 0.05], fleshDeep: [0.6, 0.24, 0.012],
    pale: [0.84, 0.88, 0.64], skin: [0.04, 0.15, 0.03], stripe: [0.007, 0.04, 0.01],
    seed: [0.012, 0.008, 0.005], shadowTint: [0.64, 0.55, 0.44],
    ui: { flesh: [0.72, 0.3, 0.02] },
  },
  rose: {
    name: 'Rosé',
    flesh: [0.95, 0.2, 0.3], fleshDeep: [0.6, 0.08, 0.15],
    pale: [0.84, 0.9, 0.72], skin: [0.06, 0.2, 0.1], stripe: [0.012, 0.06, 0.03],
    seed: [0.014, 0.009, 0.007], shadowTint: [0.64, 0.5, 0.52],
    ui: { flesh: [0.72, 0.16, 0.24] },
  },
};

export const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function linToHex(rgb) {
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, linToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
}

export function hexToLin(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => srgbToLin(parseInt(h.slice(i, i + 2), 16) / 255));
}
