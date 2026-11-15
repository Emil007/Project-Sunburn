uniform float u_amount; // setting "amount" (0..100)
vec4 filter(sampler2D tex, vec2 uv, vec2 texSize, vec2 outSize) {
  vec2 p = (floor(uv * texSize) + 0.5) / texSize;            // nearest-neighbour sample
  vec3 c = texture(tex, p).rgb;
  vec3 s = vec3(dot(c, vec3(.393, .769, .189)), dot(c, vec3(.349, .686, .168)), dot(c, vec3(.272, .534, .131)));
  return vec4(mix(c, min(s, 1.0), u_amount / 100.0), 1.0);
}
