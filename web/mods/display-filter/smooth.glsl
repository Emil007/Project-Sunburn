vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  // manual bilinear (the base texture is sampled with NEAREST)
  vec2 p = uv * texSize - 0.5; vec2 f = fract(p); vec2 b = (floor(p) + 0.5) / texSize; vec2 d = 1.0 / texSize;
  vec4 a = texture(tex, b), c = texture(tex, b + vec2(d.x, 0.0)), e = texture(tex, b + vec2(0.0, d.y)), g = texture(tex, b + d);
  return mix(mix(a, c, f.x), mix(e, g, f.x), f.y);
}
