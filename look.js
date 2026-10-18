// Llama Land — an optional "look": subtle gradients and paper-like grain (after the Noodle Guy
// prototype). Everything stays unlit and flat-coloured underneath; this only nudges each colour:
//   · rounded shapes get a soft light from the upper left (from their surface direction on screen)
//   · things are a touch lighter the higher they stand (heads lighter than hooves)
//   · the ground is faintly darker toward the edges of the screen
//   · a fine grain over everything (shadows too), fixed to the screen like paper
// It works by patching three's built-in basic and shadow materials as they compile, so main.js
// needs only two lines: the import, and lookSetup(scene, renderer) once the scene exists.
// To turn off: LOOK_ON = false here. To remove: delete this file and those two lines in main.js.
import * as THREE from 'three';

const LOOK_ON = true;            // ← false: the original flat look
const LOOK = {
  grain: 0.1,                   // ← grain strength (Noodle Guy uses ~0.09)
  form: 0.03,                    // ← how much the soft upper-left light rounds the shapes
  height: 0.07,                  // ← lighter higher up, darker near the ground
  vignette: 0.06,                // ← the ground darkening toward the screen's edges
};

const U = {                      // shared by every patched material
  uLookGrain: { value: LOOK.grain }, uLookForm: { value: LOOK.form }, uLookHeight: { value: LOOK.height },
};
// (a sine-free hash: the usual sin() one streaks on big screens, where it runs out of precision)
const HASH = 'float lookHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }\n';

// basic materials: a normal (if the shape has one) and a height, passed from the vertex shader
function patchBasic(sh) {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = 'varying vec3 vLookN;\nvarying float vLookY;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
    vec3 lookN = normal;
    vec4 lookW = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      lookN = mat3(instanceMatrix) * lookN;
      lookW = instanceMatrix * lookW;
    #endif
    vLookN = dot(lookN, lookN) > 0.0 ? normalize(normalMatrix * lookN) : vec3(0.0);   // (some shapes have no normals: flat)
    vLookY = (modelMatrix * lookW).y;`);
  sh.fragmentShader = 'uniform float uLookGrain, uLookForm, uLookHeight;\nvarying vec3 vLookN;\nvarying float vLookY;\n' + HASH
    + sh.fragmentShader.replace('#include <fog_fragment>', `#include <fog_fragment>
    float lookLight = 1.0 + uLookForm * (0.65 * vLookN.y - 0.35 * vLookN.x);              // soft light from the upper left
    lookLight *= 1.0 + uLookHeight * (smoothstep(0.0, 9.0, vLookY) - 0.5);              // lighter higher up
    gl_FragColor.rgb = gl_FragColor.rgb * lookLight + (lookHash(gl_FragCoord.xy) - 0.5) * uLookGrain;`);
}
// shadows: grain in their strength, so they look printed rather than airbrushed
function patchShadow(sh) {
  Object.assign(sh.uniforms, U);
  sh.fragmentShader = 'uniform float uLookGrain;\n' + HASH + sh.fragmentShader.replace('#include <fog_fragment>',
    '#include <fog_fragment>\n    gl_FragColor.a *= 1.0 + (lookHash(gl_FragCoord.xy) - 0.5) * uLookGrain * 7.0;');
}
if (LOOK_ON) {
  // on the prototypes, so every basic and shadow material (made now or later) picks it up
  THREE.MeshBasicMaterial.prototype.onBeforeCompile = patchBasic;
  THREE.ShadowMaterial.prototype.onBeforeCompile = patchShadow;
}

// the ground: drawn first, behind everything, in the ground colour — faintly darker toward the
// screen's edges, with the grain
export function lookSetup(scene, renderer) {
  if (!LOOK_ON) return;
  const base = new THREE.Color();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Vector3() }, uVig: { value: LOOK.vignette }, ...U },
    vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.9999, 1.0); }',
    fragmentShader: 'uniform vec3 uBase; uniform float uVig, uLookGrain; varying vec2 vUv;\n' + HASH + `
      void main() {
        vec2 d = vUv - vec2(0.45, 0.55);
        vec3 c = uBase * (1.0 - uVig * smoothstep(0.15, 0.85, length(d * vec2(1.0, 1.2))));
        gl_FragColor = vec4(c + (lookHash(gl_FragCoord.xy) - 0.5) * uLookGrain, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  ground.frustumCulled = false;
  ground.renderOrder = -1000;                     // before everything
  ground.onBeforeRender = () => {                 // follows the ground colour (sRGB, as it's shown)
    renderer.getClearColor(base);
    const c = base.clone().convertLinearToSRGB();
    mat.uniforms.uBase.value.set(c.r, c.g, c.b);
  };
  scene.add(ground);
}
