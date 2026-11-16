uniform float u_strength; // setting "strength" (0..100) is passed as u_strength
vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  vec2 p = uv * texSize - 0.5; vec2 f = fract(p); vec2 b = (floor(p) + 0.5) / texSize; vec2 d = 1.0 / texSize;
  vec4 c0 = mix(texture(tex, b), texture(tex, b + vec2(d.x, 0.0)), smoothstep(0.2, 0.8, f.x));
  vec4 c1 = mix(texture(tex, b + vec2(0.0, d.y)), texture(tex, b + d), smoothstep(0.2, 0.8, f.x));
  vec4 c = mix(c0, c1, smoothstep(0.3, 0.7, f.y));
  float k = u_strength / 100.0;
  float line = mix(1.0, 0.45 + 0.55 * pow(abs(sin(uv.y * texSize.y * 3.14159265)), 0.7), k);
  vec2 q = uv * 2.0 - 1.0; float vig = 1.0 - 0.15 * dot(q, q);
  float mask = 0.94 + 0.06 * sin(uv.x * outSize.x * 2.094);
  return vec4(c.rgb * line * vig * mask * (1.0 + 0.35 * k), 1.0);
}
