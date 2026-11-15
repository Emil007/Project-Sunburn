// sharp-bilinear: integer prescale + bilinear for the remainder
vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  vec2 texel = uv * texSize;
  vec2 scale = max(floor(outSize / texSize), vec2(1.0));
  vec2 tf = floor(texel), s = fract(texel);
  vec2 rr = 0.5 - 0.5 / scale, cd = s - 0.5;
  vec2 f = (cd - clamp(cd, -rr, rr)) * scale + 0.5;
  return texture(tex, (tf + f) / texSize);
}
