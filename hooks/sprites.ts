// Clawd's official sprites, as clawd-desk caches them from the desktop app's bundle
// (~/.claude/clawd-desk/sprites.cache.js). Each sprite is a palette, a base frame of
// base-36 palette indices ('.' is clear) and per-frame deltas.

export type Sprite = { w: number; h: number; palette: string[]; frames: number[][] }

const PATTERN =
  /(\w+):\{cat:"\w+",w:(\d+),h:(\d+),fps:\d+,palette:\[([^\]]*)\],base:"([^"]*)",deltas:(?:"([^"]*)"\.split\("\("\)|\[([^\]]*)\]),a0:\[([^\]]*)\]/g

const CLEAR = 255
const cell = (c: string): number => (c === '.' ? CLEAR : Number.parseInt(c, 36))

export function parseSprites(src: string): Record<string, Sprite> {
  const out: Record<string, Sprite> = {}
  for (const m of src.matchAll(PATTERN)) {
    const [, name, ws, hs, pal, base, split, arr] = m
    if (!name || !ws || !hs || pal === undefined || base === undefined) continue
    const w = Number(ws)
    const h = Number(hs)
    const palette = pal.split(',').map(s => s.replace(/["\s]/g, ''))
    const deltas = split !== undefined ? split.split('(') : arr !== undefined ? [...arr.matchAll(/"([^"]*)"/g)].map(x => x[1] ?? '') : null
    if (!deltas) continue
    const px = [...base].map(cell)
    if (px.length !== w * h) continue
    const frames = [px.slice()]
    for (const d of deltas) {
      if (d) {
        for (const t of d.split(',')) {
          const pos = Number.parseInt(t.slice(0, -1), 36)
          if (Number.isFinite(pos) && pos < px.length) px[pos] = cell(t.slice(-1))
        }
      }
      frames.push(px.slice())
    }
    out[name] = { w, h, palette, frames }
  }
  return out
}

// One frame as a path per color: each row's runs of a color become one rectangle.
function framePaths(s: Sprite, px: number[]): string {
  const byColor = new Map<number, string[]>()
  for (let y = 0; y < s.h; y++) {
    let x = 0
    while (x < s.w) {
      const c = px[y * s.w + x]!
      let end = x + 1
      while (end < s.w && px[y * s.w + end] === c) end++
      if (c !== CLEAR && c < s.palette.length) {
        const list = byColor.get(c) ?? []
        list.push(`M${x} ${y}h${end - x}v1h-${end - x}z`)
        byColor.set(c, list)
      }
      x = end
    }
  }
  return [...byColor].map(([c, d]) => `<path fill="${s.palette[c]}" d="${d.join('')}"/>`).join('')
}

// A looping clip as an SVG <symbol>, its frames stepped by CSS; reduced motion holds the first.
// `frames` picks which frames play, in order. Returns the symbol and the style it needs.
export function clipSymbol(s: Sprite, id: string, frames: number[], seconds: number): { symbol: string; style: string } {
  const picked = frames.filter(i => i >= 0 && i < s.frames.length)
  const n = Math.max(1, picked.length)
  const groups = picked.map((i, k) => `<g class="${id}f" style="animation-delay:${(-(seconds * k) / n).toFixed(3)}s">${framePaths(s, s.frames[i]!)}</g>`).join('')
  const style =
    `.${id}f{opacity:0;animation:${id}a ${seconds}s step-end infinite}` +
    `@keyframes ${id}a{0%{opacity:1}${(100 / n).toFixed(3)}%{opacity:0}}` +
    `@media (prefers-reduced-motion: reduce){.${id}f{animation:none}.${id}f:first-child{opacity:1}}`
  return { symbol: `<symbol id="${id}" viewBox="0 0 ${s.w} ${s.h}" shape-rendering="crispEdges">${groups}</symbol>`, style }
}

// Every other frame of a range, so the clip stays small.
export const every = (from: number, to: number, step = 2): number[] => {
  const out: number[] = []
  for (let i = from; i <= to; i += step) out.push(i)
  return out
}
