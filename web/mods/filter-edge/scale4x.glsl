// Scale4x (EPX applied twice), evaluated per output pixel. The 4x image is sampled at the
// nearest cell; when the picture is shown bigger than 4x it is blended between cells.
vec3 px(sampler2D t, vec2 c, vec2 ts) { return texelFetch(t, ivec2(clamp(c, vec2(0.0), ts - 1.0)), 0).rgb; }
bool eq(vec3 a, vec3 b) { return dot(abs(a - b), vec3(1.0)) < 0.02; }
// EPX rule: which neighbour (or the centre) a sub-cell takes
vec3 epx(vec3 P, vec3 A, vec3 B, vec3 C, vec3 D, vec2 sub) {
  if (sub.x < 0.5 && sub.y < 0.5) return (eq(C, A) && !eq(C, D) && !eq(A, B)) ? A : P;
  if (sub.x > 0.5 && sub.y < 0.5) return (eq(A, B) && !eq(A, C) && !eq(B, D)) ? B : P;
  if (sub.x < 0.5 && sub.y > 0.5) return (eq(D, C) && !eq(D, B) && !eq(C, A)) ? C : P;
  return (eq(B, D) && !eq(B, A) && !eq(D, C)) ? D : P;
}
// value of the 2x image at integer 2x coordinate q
vec3 s2(sampler2D t, vec2 q, vec2 ts) {
  vec2 c = floor(q / 2.0);
  return epx(px(t, c, ts), px(t, c + vec2(0, -1), ts), px(t, c + vec2(1, 0), ts), px(t, c + vec2(-1, 0), ts), px(t, c + vec2(0, 1), ts), q - c * 2.0);
}
// value of the 4x image at integer 4x coordinate r
vec3 s4(sampler2D t, vec2 r, vec2 ts) {
  vec2 c = floor(r / 2.0);
  return epx(s2(t, c, ts), s2(t, c + vec2(0, -1), ts), s2(t, c + vec2(1, 0), ts), s2(t, c + vec2(-1, 0), ts), s2(t, c + vec2(0, 1), ts), r - c * 2.0);
}
vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  vec2 p = uv * texSize * 4.0;
  if (outSize.x < texSize.x * 4.0) return vec4(s4(tex, floor(p), texSize), 1.0);   // shown smaller than 4x: one sample
  vec2 q = p - 0.5; vec2 f = fract(q); vec2 b = floor(q);
  vec3 a = s4(tex, b, texSize), c = s4(tex, b + vec2(1, 0), texSize), e = s4(tex, b + vec2(0, 1), texSize), g = s4(tex, b + vec2(1, 1), texSize);
  return vec4(mix(mix(a, c, f.x), mix(e, g, f.x), f.y), 1.0);
}
