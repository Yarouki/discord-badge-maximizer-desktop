import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GAMES, STEP_NAMES, clamp, fmt, isSoftwareRenderer, smooth } from './logic.js';

function webglRendererName(gl) {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || '');
}

export function buildScene({ S, $, scrollToF, getPageY, isWalking, log }) {
  const canvas = $('#gl');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true,
  });
  const rendererName = webglRendererName(renderer.getContext());
  if (isSoftwareRenderer(rendererName)) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw new Error(`3D view needs a graphics card, found only "${rendererName}"`);
  }
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  let W = innerWidth, H = innerHeight;
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.info.autoReset = false;

  const NIGHT = new THREE.Color('#15162B');
  const scene = new THREE.Scene();
  scene.background = NIGHT;
  scene.fog = new THREE.FogExp2(NIGHT, 0.0165);
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 420);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.9;

  const rt = new THREE.WebGLRenderTarget(W * DPR, H * DPR, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(DPR);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.36, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const key = new THREE.DirectionalLight('#FFE6BF', 2.4);
  key.position.set(6, 9, 12);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#6E7BFF', 2.0);
  rim.position.set(-8, -3, -6);
  scene.add(rim);

  const T = { time: 0 };

  function radialTexture(stops) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    stops.forEach(([o, col]) => g.addColorStop(o, col));
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const softDot = radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);

  {
    const N = 4200;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      pos[i * 3] = THREE.MathUtils.randFloat(-42, 42);
      pos[i * 3 + 1] = THREE.MathUtils.randFloat(-22, 22);
      pos[i * 3 + 2] = THREE.MathUtils.randFloat(-275, 30);
      c.set(Math.random() < 0.7 ? '#9AA2FA' : (Math.random() < 0.5 ? '#FFC34B' : '#EB459E'));
      c.multiplyScalar(0.5 + Math.random() * 0.7);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 0.16, map: softDot, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    scene.add(new THREE.Points(g, m));
  }

  const svgLoader = new SVGLoader();
  function fillSampler(fill) {
    if (!fill || !fill.startsWith('url(')) {
      const c = new THREE.Color(fill || '#FFC34B');
      return (x, y, out) => out.copy(c);
    }
    const id = fill.slice(5, -1);
    const gEl = document.getElementById(id);
    const x1 = +gEl.getAttribute('x1'), x2 = +gEl.getAttribute('x2'), y1 = +gEl.getAttribute('y1'), y2 = +gEl.getAttribute('y2');
    const stops = [...gEl.querySelectorAll('stop')].map((s) => ({ o: parseFloat(s.getAttribute('offset') || '0'), c: new THREE.Color(s.getAttribute('stop-color')) }));
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
    return (x, y, out) => {
      const t = clamp(((x - x1) * dx + (y - y1) * dy) / len2, 0, 1);
      if (t <= stops[0].o) return out.copy(stops[0].c);
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i].o) return out.copy(stops[i - 1].c).lerp(stops[i].c, (t - stops[i - 1].o) / Math.max(1e-4, stops[i].o - stops[i - 1].o));
      }
      return out.copy(stops[stops.length - 1].c);
    };
  }
  const ICON_SCALE = 0.074;
  function iconGeometry(symbolId) {
    const pathEls = [...document.getElementById(symbolId).querySelectorAll('path')];
    const parts = [];
    const c = new THREE.Color();
    pathEls.forEach((el, i) => {
      const data = svgLoader.parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000000" d="${el.getAttribute('d')}"/></svg>`);
      const shapes = data.paths.flatMap((p) => p.toShapes())
        .filter((s) => Math.abs(THREE.ShapeUtils.area(s.getPoints(6))) > 0.05);
      if (!shapes.length) return;
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.8, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.07, bevelSegments: 3, curveSegments: 12 });
      const sample = fillSampler(el.getAttribute('fill'));
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) {
        sample(pos.getX(k), pos.getY(k), c);
        colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.scale(1, -1, -1);
      geo.translate(-12, 12, i * 0.17);
      parts.push(geo);
    });
    const merged = mergeGeometries(parts);
    merged.scale(ICON_SCALE, ICON_SCALE, ICON_SCALE);
    merged.computeVertexNormals();
    return merged;
  }
  const iconGeos = { gametime: iconGeometry('ic-gametime'), variety: iconGeometry('ic-variety'), stream: iconGeometry('ic-stream') };

  function guillocheTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(256, 230, 20, 256, 256, 256);
    g.addColorStop(0, '#4A52D6'); g.addColorStop(0.55, '#2B2F8C'); g.addColorStop(1, '#1A1C5C');
    x.fillStyle = g; x.fillRect(0, 0, 512, 512);
    x.translate(256, 256);
    x.strokeStyle = 'rgba(170,180,255,0.22)'; x.lineWidth = 1.3;
    for (let i = 0; i < 72; i++) {
      x.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.03) {
        const r = 150 + 70 * Math.sin(a * 6 + i * 0.087) * Math.cos(a * 2);
        const px = Math.cos(a + i * 0.0873) * r * 0.62, py = Math.sin(a + i * 0.0873) * r * 0.62;
        if (a === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  const guilloche = guillocheTexture();
  const discGeo = new THREE.CylinderGeometry(1.06, 1.06, 0.18, 96, 1).rotateX(Math.PI / 2);
  const rimGeo = new THREE.TorusGeometry(1.14, 0.105, 24, 128);
  const innerRimGeo = new THREE.TorusGeometry(0.97, 0.022, 10, 128);

  function addHeat(mat, u) {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHeat; uniform float uGlow;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 hotCol = diffuseColor.rgb;
          float lumH = dot(hotCol, vec3(0.2126, 0.7152, 0.0722));
          vec3 steelH = mix(vec3(0.045, 0.048, 0.055), vec3(0.2, 0.207, 0.225), clamp(lumH * 1.3, 0.0, 1.0));
          diffuseColor.rgb = mix(steelH, hotCol, smoothstep(0.3, 1.0, uHeat));`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.6, roughnessFactor, uHeat);')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += mix(vec3(1.0, 0.06, 0.015), hotCol, smoothstep(0.25, 0.85, uHeat)) * uGlow;`)
        .replace('#include <opaque_fragment>', `outgoingLight *= mix(0.55, 1.0, uHeat);
          #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => `hot-metal-${mat.vertexColors ? 'v' : ''}${mat.map ? 'm' : ''}`;
    return mat;
  }
  const medallionHeats = [];
  function medallionMaterials() {
    const u = { uHeat: { value: 0 }, uGlow: { value: 0 } };
    medallionHeats.push(u);
    return {
      gold: addHeat(new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 1, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.25 }), u),
      rim: addHeat(new THREE.MeshPhysicalMaterial({ color: '#FFB637', metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }), u),
      enamel: addHeat(new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', map: guilloche, metalness: 0.25, roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 0.45 }), u),
      edge: addHeat(new THREE.MeshPhysicalMaterial({ color: '#E8901C', metalness: 1, roughness: 0.3 }), u),
    };
  }

  function makeMedallion(kind) {
    const g = new THREE.Group();
    const m = medallionMaterials();
    g.add(new THREE.Mesh(discGeo, [m.edge, m.enamel, m.enamel]));
    g.add(new THREE.Mesh(rimGeo, m.rim));
    const ir = new THREE.Mesh(innerRimGeo, m.rim); ir.position.z = 0.09; g.add(ir);
    const ir2 = ir.clone(); ir2.position.z = -0.09; g.add(ir2);
    const front = new THREE.Mesh(iconGeos[kind], m.gold); front.position.z = 0.1; g.add(front);
    const back = new THREE.Mesh(iconGeos[kind], m.gold); back.rotation.y = Math.PI; back.position.z = -0.1; g.add(back);
    return g;
  }

  const HEAT_MS = 1500, HEAT_STAGGER_MS = 220, COOL_MS = 1200, HEAT_GLOW_PEAK = 1.3;
  const heatFx = { tweens: [] };
  function heatTo(target, instant) {
    heatFx.tweens = medallionHeats.map((u, i) => ({
      u, from: u.uHeat.value, to: target, t: instant ? 1 : 0,
      delay: target ? (i % 3) * HEAT_STAGGER_MS / 1000 : 0,
      dur: (target ? HEAT_MS : COOL_MS) / 1000,
    }));
    if (instant) heatFx.tweens.forEach((tw) => { tw.u.uHeat.value = target; tw.u.uGlow.value = 0; });
  }
  function updateHeat(dt) {
    heatFx.tweens.forEach((tw) => {
      if (tw.t >= 1) return;
      if (tw.delay > 0) { tw.delay -= dt; return; }
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;
      tw.u.uHeat.value = tw.from + (tw.to - tw.from) * e;
      tw.u.uGlow.value = tw.to > tw.from ? Math.pow(Math.sin(Math.PI * e), 1.4) * HEAT_GLOW_PEAK : 0;
    });
  }

  const HERO_C = new THREE.Vector3(2.4, 0.05, 0);
  const hero = new THREE.Group();
  scene.add(hero);
  const heroMeds = ['gametime', 'variety', 'stream'].map((k) => { const m = makeMedallion(k); hero.add(m); return m; });
  const heroGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: '#5865F2', transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  heroGlow.position.copy(HERO_C).add(new THREE.Vector3(0, 0, -3)); heroGlow.scale.set(13, 13, 1);
  hero.add(heroGlow);
  const shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 8, 160), new THREE.MeshBasicMaterial({ color: new THREE.Color('#8C96FF').multiplyScalar(2.2), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  shock.position.copy(HERO_C);
  hero.add(shock);
  const heroFx = { speed: 1, speedTarget: 1, spinBoost: 0, shockT: -1 };

  const TUN_NEAR = -18, TUN_FAR = -156, TUN_LEN = TUN_NEAR - TUN_FAR;
  function makeAtlas() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 2048;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 2048, 2048);
    x.globalCompositeOperation = 'lighter';
    GAMES.forEach((name, i) => {
      const ox = (i % 4) * 512, oy = Math.floor(i / 4) * 256;
      x.save();
      x.beginPath(); x.rect(ox + 4, oy + 4, 504, 248); x.clip();
      x.fillStyle = 'rgb(0,0,255)';
      x.font = '900 340px Anybody';
      x.fillText(name[0], ox + 300, oy + 300);
      x.fillStyle = 'rgb(0,255,0)';
      x.font = '500 25px Onest';
      x.fillText('Detectable game', ox + 38, oy + 206);
      x.fillRect(ox + 38, oy + 44, 44, 6);
      x.fillStyle = 'rgb(255,0,0)';
      let size = 54;
      x.font = `650 ${size}px Onest`;
      while (x.measureText(name).width > 430 && size > 26) { size -= 2; x.font = `650 ${size}px Onest`; }
      x.fillText(name, ox + 36, oy + 156);
      x.restore();
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
    return t;
  }
  const CARD_RINGS = 24, PER_RING = 11, CARDS = CARD_RINGS * PER_RING;
  const tunnelGeo = new THREE.InstancedBufferGeometry();
  {
    const plane = new THREE.PlaneGeometry(1, 1);
    tunnelGeo.index = plane.index;
    tunnelGeo.setAttribute('position', plane.attributes.position);
    tunnelGeo.setAttribute('uv', plane.attributes.uv);
    const seed = new Float32Array(CARDS * 4);
    const flash = new Float32Array(CARDS).fill(1e6);
    for (let r = 0; r < CARD_RINGS; r++) {
      for (let k = 0; k < PER_RING; k++) {
        const i = r * PER_RING + k;
        const ang = (k / PER_RING) * Math.PI * 2 + (r % 2) * (Math.PI / PER_RING) + (Math.random() - 0.5) * 0.18;
        seed[i * 4] = ang;
        seed[i * 4 + 1] = 5.4 + (Math.random() - 0.5) * 1.1;
        seed[i * 4 + 2] = TUN_FAR + (r / CARD_RINGS) * TUN_LEN + (Math.random() - 0.5) * 2.4;
        seed[i * 4 + 3] = Math.floor(Math.random() * GAMES.length);
      }
    }
    tunnelGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    tunnelGeo.setAttribute('aFlash', new THREE.InstancedBufferAttribute(flash, 1));
    tunnelGeo.instanceCount = CARDS;
  }
  const tunnelMat = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: null }, uTravel: { value: 0 }, uTime: { value: 0 },
      uFogColor: { value: NIGHT }, uFogDensity: { value: 0.0165 },
      uWave: { value: 100 }, uCard: { value: new THREE.Vector2(2.7, 1.35) }, uVis: { value: 1 },
    },
    vertexShader: `
      attribute vec4 aSeed; attribute float aFlash;
      uniform float uTravel, uTime, uWave; uniform vec2 uCard;
      varying vec2 vUv; varying float vCell, vFlash, vClaimed, vDist, vWave;
      const float NEAR = ${TUN_NEAR.toFixed(1)}; const float FAR = ${TUN_FAR.toFixed(1)}; const float LEN = ${TUN_LEN.toFixed(1)};
      void main() {
        float ang = aSeed.x;
        float z = FAR + mod(aSeed.z - FAR + uTravel, LEN);
        float edge = (1.0 - smoothstep(NEAR - 6.0, NEAR, z)) * smoothstep(FAR, FAR + 10.0, z);
        vec3 radial = vec3(cos(ang), sin(ang), 0.0);
        vec3 center = radial * aSeed.y + vec3(0.0, 0.0, z);
        vec3 n = normalize(-radial * 0.66 + vec3(0.0, 0.0, 0.75));
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), n));
        vec3 up = cross(n, right);
        vec3 p = center + (right * position.x * uCard.x + up * position.y * uCard.y) * edge;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vUv = uv; vCell = aSeed.w; vDist = -mv.z;
        float age = uTime - aFlash;
        vFlash = age >= 0.0 ? exp(-age * 1.4) : 0.0;
        vClaimed = age >= 0.0 ? 1.0 : 0.0;
        float wz = NEAR - uWave * 70.0;
        float wq = (z - wz) / 5.0;
        vWave = uWave < 3.0 ? exp(-wq * wq) : 0.0;
      }`,
    fragmentShader: `
      uniform sampler2D uAtlas; uniform vec3 uFogColor; uniform float uFogDensity, uTime, uVis; uniform vec2 uCard;
      varying vec2 vUv; varying float vCell, vFlash, vClaimed, vDist, vWave;
      void main() {
        float cell = floor(vCell + 0.5);
        float col = cell - 4.0 * floor(cell / 4.0 + 0.01), row = floor(cell / 4.0 + 0.01);
        vec2 uv = clamp(vUv, 0.012, 0.988);
        vec2 auv = vec2((col + uv.x) / 4.0, 1.0 - (row + 1.0) / 8.0 + uv.y / 8.0);
        vec3 t = texture2D(uAtlas, auv).rgb;
        float txt = t.r, deco = t.g, big = t.b;
        vec2 b = min(vUv, 1.0 - vUv) * uCard;
        float border = 1.0 - smoothstep(0.0, 0.035, min(b.x, b.y));
        vec3 panel = mix(vec3(0.018, 0.019, 0.055), vec3(0.045, 0.048, 0.135), vUv.y);
        vec3 c = panel + big * vec3(0.03, 0.035, 0.12) + deco * vec3(0.30, 0.34, 0.95) * 0.5 + txt * vec3(0.72);
        c += border * vec3(0.16, 0.19, 0.62);
        float sweep = smoothstep(0.06, 0.0, abs(fract(vUv.x * 0.6 - vUv.y * 0.25 - uTime * 0.12 + vCell * 0.37) - 0.5));
        c += sweep * 0.05;
        vec3 gold = mix(vec3(0.85, 0.22, 0.01), vec3(1.0, 0.72, 0.16), vUv.y + big * 0.2);
        vec3 goldCard = gold * (1.0 - txt * 0.9) + border * vec3(1.0, 0.85, 0.4) + deco * vec3(0.4, 0.12, 0.0);
        float g = clamp(vClaimed * 0.42 + vFlash + vWave, 0.0, 1.0);
        c = mix(c, goldCard, g);
        c *= 1.0 + (vFlash + vWave) * 1.3;
        float fd = max(vDist, 0.0) * uFogDensity;
        float f = 1.0 - exp(-fd * fd);
        c = mix(uFogColor, mix(c, uFogColor, f), uVis);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat);
  tunnel.frustumCulled = false;
  scene.add(tunnel);
  const tunnelEnd = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: '#C2479E', transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
  tunnelEnd.renderOrder = 5;
  tunnelEnd.position.set(0, 0, TUN_FAR - 4); tunnelEnd.scale.set(34, 34, 1);
  scene.add(tunnelEnd);
  const tunFx = { travel: 0, speed: 1.6, speedTarget: 1.6, kick: 0, waveT: 100 };
  const seedArr = tunnelGeo.attributes.aSeed.array;
  const flashAttr = tunnelGeo.attributes.aFlash;

  const SC = new THREE.Vector3(-7, 0.6, -180);
  const stream = new THREE.Group(); stream.position.copy(SC); scene.add(stream);
  const SW = 13, SH = SW * 9 / 16;
  const screenFrame = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.5, SH + 0.5, 0.35), new THREE.MeshPhysicalMaterial({ color: '#1A1B33', metalness: 0.85, roughness: 0.35, clearcoat: 0.6, transparent: true }));
  screenFrame.position.z = -0.2; screenFrame.renderOrder = -1; stream.add(screenFrame);
  const bezelGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#EB459E'), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const bezelGlow = new THREE.Mesh(new THREE.PlaneGeometry(SW + 0.9, SH + 0.9), bezelGlowMat);
  bezelGlow.position.z = -0.4; stream.add(bezelGlow);
  const screenCanvas = document.createElement('canvas'); screenCanvas.width = 1024; screenCanvas.height = 576;
  const screenCtx = screenCanvas.getContext('2d');
  const screenTex = new THREE.CanvasTexture(screenCanvas); screenTex.colorSpace = THREE.SRGBColorSpace;
  const video = $('#streamVideo');
  const videoTex = new THREE.VideoTexture(video); videoTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false, color: new THREE.Color(1, 1, 1), transparent: true });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), screenMat);
  screen.position.z = 0.0; screen.renderOrder = -1; stream.add(screen);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: '#EB459E', transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  halo.position.set(0, 0, -1.2); halo.scale.set(34, 22, 1); stream.add(halo);

  const FLOOR_Y = -SH / 2 - 1.1;
  const poolTex = radialTexture([[0, 'rgba(255,110,190,0.95)'], [0.35, 'rgba(235,69,158,0.45)'], [1, 'rgba(235,69,158,0)']]);
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(34, 20), poolMat);
  pool.rotation.x = -Math.PI / 2; pool.position.set(2, FLOOR_Y, 5); stream.add(pool);
  const fadeCanvas = document.createElement('canvas'); fadeCanvas.width = 4; fadeCanvas.height = 128;
  { const fx2 = fadeCanvas.getContext('2d'); const gr = fx2.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, '#000'); gr.addColorStop(0.55, '#000'); gr.addColorStop(1, '#fff'); fx2.fillStyle = gr; fx2.fillRect(0, 0, 4, 128); }
  const reflMat = new THREE.MeshBasicMaterial({ map: screenTex, alphaMap: new THREE.CanvasTexture(fadeCanvas), transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const refl = new THREE.Mesh(screen.geometry, reflMat);
  refl.position.set(0, 2 * FLOOR_Y, 0); refl.scale.y = -1; stream.add(refl);

  const apex = new THREE.Vector3(4.5, 13, 2.5);
  const spot = new THREE.SpotLight('#EB459E', 0, 0, 0.5, 0.7, 1.6);
  spot.position.copy(apex); spot.target.position.set(0, -1.5, 0);
  stream.add(spot, spot.target);
  const screenLight = new THREE.PointLight('#9AA2FA', 0, 30, 1.6);
  screenLight.position.set(0, -2, 3); stream.add(screenLight);

  const coneH = 15.5;
  const coneGeo = new THREE.ConeGeometry(4.6, coneH, 64, 1, true).translate(0, -coneH / 2, 0);
  const coneMat = new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0.15 }, uColor: { value: new THREE.Color('#EB459E') }, uTime: { value: 0 } },
    vertexShader: `
      varying float vH; varying vec3 vN; varying vec3 vV;
      void main() {
        vH = -position.y / ${coneH.toFixed(1)};
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uPower, uTime; uniform vec3 uColor;
      varying float vH; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float h = clamp(vH, 0.0, 1.0); // MSAA can extrapolate vH past [0, 1]; pow() of a negative base is NaN
        float a = pow(1.0 - h, 1.4) * facing * smoothstep(0.0, 0.08, h);
        a *= 0.85 + 0.15 * sin(uTime * 2.1 + h * 9.0);
        gl_FragColor = vec4(uColor * a * uPower * 0.55, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.copy(apex);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1.5, 0).sub(apex).normalize());
  stream.add(cone);
  const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: '#FF8FCB', transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  lamp.position.copy(apex); lamp.scale.set(3, 3, 1); stream.add(lamp);

  const HAZE = 420;
  const hazeGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(HAZE * 3), s = new Float32Array(HAZE);
    for (let i = 0; i < HAZE; i++) {
      p[i * 3] = THREE.MathUtils.randFloat(-8, 10);
      p[i * 3 + 1] = THREE.MathUtils.randFloat(0, 14);
      p[i * 3 + 2] = THREE.MathUtils.randFloat(0.4, 6);
      s[i] = Math.random();
    }
    hazeGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    hazeGeo.setAttribute('aRand', new THREE.BufferAttribute(s, 1));
  }
  const hazeMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0.2 }, uMap: { value: softDot }, uScale: { value: H * 0.5 } },
    vertexShader: `
      attribute float aRand; uniform float uTime, uScale; varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.25 + aRand * 0.35), 14.0) - 6.0;
        p.x += sin(uTime * 0.3 + aRand * 20.0) * 0.6;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.12 + aRand * 0.3) * uScale / -mv.z;
        vA = smoothstep(-6.0, -3.0, p.y) * (1.0 - smoothstep(5.0, 8.0, p.y)) * (0.35 + aRand * 0.65);
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform float uPower; varying float vA;
      void main() {
        float m = texture2D(uMap, gl_PointCoord).a;
        gl_FragColor = vec4(vec3(1.0, 0.36, 0.72) * m * vA * uPower, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const haze = new THREE.Points(hazeGeo, hazeMat); stream.add(haze);
  let previewFailed = false;
  function previewPlayFailed(err) {
    if (err && err.name === 'AbortError') return;
    if (previewFailed) return;
    previewFailed = true;
    log("The preview on the screen here couldn't play. Your Discord stream isn't affected.");
  }
  const strFx = { power: 0.12, powerTarget: 0.12, screenOn: 0, screenTarget: 0, lastDraw: 0 };

  function drawScreen(mode) {
    const x = screenCtx, Wc = 1024, Hc = 576;
    const g = x.createLinearGradient(0, 0, 0, Hc);
    g.addColorStop(0, '#11122A'); g.addColorStop(1, '#0A0B1C');
    x.fillStyle = g; x.fillRect(0, 0, Wc, Hc);
    x.strokeStyle = 'rgba(154,162,250,0.06)'; x.lineWidth = 1;
    for (let i = 0; i < Wc; i += 48) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, Hc); x.stroke(); }
    for (let j = 0; j < Hc; j += 48) { x.beginPath(); x.moveTo(0, j); x.lineTo(Wc, j); x.stroke(); }
    x.textAlign = 'center';
    if (mode === 'off') {
      x.fillStyle = '#F2F3F5'; x.font = '700 56px Anybody';
      x.fillText('Stream is off', Wc / 2, Hc / 2 - 6);
      x.fillStyle = '#B5BAC1'; x.font = '500 26px Onest';
      x.fillText('Press Start stream to go live in your voice channel', Wc / 2, Hc / 2 + 44);
    } else if (mode === 'connecting') {
      x.fillStyle = '#F2F3F5'; x.font = '700 56px Anybody';
      x.fillText('Connecting', Wc / 2, Hc / 2 - 6);
      x.fillStyle = '#F58BC4'; x.font = '500 26px Onest';
      x.fillText(STEP_NAMES[Math.min(S.stream.step, 3)], Wc / 2, Hc / 2 + 44);
    } else {
      const t = performance.now() / 1000;
      x.textAlign = 'left';
      x.fillStyle = '#EB459E'; x.fillRect(40, 38, 92, 40);
      x.fillStyle = '#15162B'; x.font = '700 24px Onest'; x.fillText('LIVE', 58, 66);
      x.fillStyle = '#F2F3F5'; x.font = '600 26px Onest'; x.fillText('Silent keepalive', 152, 66);
      x.strokeStyle = '#EB459E'; x.lineWidth = 4; x.shadowColor = '#EB459E'; x.shadowBlur = 18;
      x.beginPath();
      for (let i = 0; i <= Wc; i += 6) {
        const yy = Hc / 2 + 10 + Math.sin(i * 0.02 + t * 3) * 6 * Math.sin(t * 0.7 + i * 0.004) + Math.sin(i * 0.11 - t * 9) * 1.5;
        if (i === 0) x.moveTo(i, yy); else x.lineTo(i, yy);
      }
      x.stroke(); x.shadowBlur = 0;
      x.fillStyle = '#B5BAC1'; x.font = '500 24px Onest'; x.textAlign = 'center';
      x.fillText('No video is sent. The stream stays open.', Wc / 2, Hc - 60);
    }
    screenTex.needsUpdate = true;
  }

  const ALT_MAIN = new THREE.Vector3(2.0, -0.4, -210);
  const ALT_ALT = new THREE.Vector3(7.0, -0.4, -210);
  const orbVert = `
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vP = position;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`;
  const orbFrag = `
    uniform vec3 uColor; uniform float uTime, uPower;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.2);
      float sw = sin(vP.x * 3.1 + uTime * 1.3) * sin(vP.y * 3.7 - uTime * 1.1) * sin(vP.z * 2.9 + uTime * 0.8);
      vec3 core = uColor * (0.32 + 0.22 * sw);
      vec3 c = core * uPower + uColor * fres * 2.4 * uPower + vec3(1.0) * pow(fres, 7.0) * 0.8 * uPower;
      gl_FragColor = vec4(c + vec3(0.02, 0.02, 0.05), 1.0);
    }`;
  function makeOrb(color, pos) {
    const g = new THREE.Group(); g.position.copy(pos);
    const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uPower: { value: 1 } }, vertexShader: orbVert, fragmentShader: orbFrag });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.08, 64, 48), mat); g.add(sphere);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.4), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.012, 6, 160), ringMat); ring1.rotation.x = 1.25; g.add(ring1);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.008, 6, 160), ringMat); ring2.rotation.set(1.0, 0.5, 0); g.add(ring2);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    glow.scale.set(5, 5, 1); g.add(glow);
    scene.add(g);
    return { g, mat, ring1, ring2, ringMat, glow, color: new THREE.Color(color) };
  }
  const orbMain = makeOrb('#5865F2', ALT_MAIN);
  const orbAlt = makeOrb('#B07CFF', ALT_ALT);
  const ALT_IDLE_COLOR = new THREE.Color('#3A3D5E');
  const beamCurve = new THREE.QuadraticBezierCurve3(ALT_MAIN.clone().add(new THREE.Vector3(1.15, 0.2, 0)), ALT_MAIN.clone().lerp(ALT_ALT, 0.5).add(new THREE.Vector3(0, 1.6, 0.6)), ALT_ALT.clone().add(new THREE.Vector3(-1.15, 0.2, 0)));
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uJoined: { value: 0 }, uWatch: { value: 0 }, uGrow: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime, uJoined, uWatch, uGrow; varying vec2 vUv;
      void main() {
        if (vUv.x > uGrow) discard;
        float dash = step(0.55, fract(vUv.x * 22.0 - uTime * 0.9));
        float pulse = pow(max(0.5 + 0.5 * sin((vUv.x * 5.0 - uTime * 1.6) * 6.2831), 0.0), 6.0);
        vec3 col = mix(vec3(0.40, 0.45, 1.0), vec3(1.0, 0.30, 0.66), vUv.x);
        float a = uJoined * dash * 0.55 + uWatch * (0.75 + 2.2 * pulse);
        float tip = smoothstep(uGrow - 0.04, uGrow, vUv.x) * uWatch * 3.0;
        gl_FragColor = vec4(col * (a + tip), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(new THREE.TubeGeometry(beamCurve, 96, 0.05, 10), beamMat); scene.add(beam);
  const beamGlowMat = new THREE.ShaderMaterial({
    uniforms: { uWatch: { value: 0 }, uGrow: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uWatch, uGrow; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ if (vUv.x > uGrow) discard; float f = pow(abs(dot(normalize(vN), normalize(vV))), 2.5);
        vec3 col = mix(vec3(0.35,0.40,0.95), vec3(0.92,0.27,0.62), vUv.x); gl_FragColor = vec4(col * f * uWatch * 0.35, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beamGlow = new THREE.Mesh(new THREE.TubeGeometry(beamCurve, 96, 0.32, 16), beamGlowMat);
  scene.add(beamGlow);
  const SPARKS = 36;
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
  const sparkMat = new THREE.PointsMaterial({ size: 0.22, map: softDot, color: new THREE.Color('#FFB3DA').multiplyScalar(1.6), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const sparks = new THREE.Points(sparkGeo, sparkMat); sparks.frustumCulled = false; scene.add(sparks);
  const platMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWatch: { value: 0 }, uBase: { value: 0.5 } },
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime, uWatch, uBase; varying vec2 vP;
      void main() {
        float r = length(vP);
        float rings = smoothstep(0.06, 0.0, abs(fract(r * 1.1 - uTime * (0.08 + uWatch * 0.25)) - 0.5) - 0.44);
        float rim = smoothstep(0.12, 0.0, abs(r - 7.6));
        float fade = 1.0 - smoothstep(4.0, 8.2, r);
        vec3 col = mix(vec3(0.34, 0.40, 0.95), vec3(0.92, 0.30, 0.64), uWatch * smoothstep(1.0, 7.0, r));
        float a = (rings * 0.32 * fade + rim * 0.55) * uBase;
        gl_FragColor = vec4(col * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const platform = new THREE.Mesh(new THREE.CircleGeometry(8, 96), platMat);
  platform.rotation.x = -Math.PI / 2;
  platform.position.copy(ALT_MAIN).lerp(ALT_ALT, 0.5).add(new THREE.Vector3(0, -2.4, 0));
  platform.scale.set(1, 0.55, 1);
  scene.add(platform);
  const altFx = { joined: 0, watch: 0, grow: 0, altPower: 0.25 };

  const BADGE_C = new THREE.Vector3(-2.6, 0, -252);
  const BADGE_GAP = 3.7;
  const badgeKinds = ['gametime', 'variety', 'stream'];
  const ringVert = `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
  const ringFrag = `
    uniform float uFill, uReveal, uTime; varying vec2 vP;
    void main() {
      float a = atan(vP.x, vP.y);
      if (a < 0.0) a += 6.28318;
      float seg = a / 6.28318 * 10.0;
      float local = fract(seg);
      if (local < 0.05 || local > 0.95) discard;
      float r = length(vP);
      float bev = smoothstep(1.47, 1.53, r) * (1.0 - smoothstep(1.62, 1.68, r));
      float fill = uFill * uReveal;
      float on = step(seg, fill);
      vec3 dim = vec3(0.035, 0.04, 0.12);
      vec3 gold = mix(vec3(1.0, 0.42, 0.04), vec3(1.0, 0.82, 0.28), bev) * 1.7;
      float head = (1.0 - smoothstep(0.0, 0.35, fill - seg)) * on;
      vec3 c = mix(dim, gold, on) + head * vec3(1.0, 0.9, 0.5) * (0.6 + 0.4 * sin(uTime * 4.0));
      gl_FragColor = vec4(c * (0.75 + 0.25 * bev), 1.0);
    }`;
  const badges = [];
  const badgeGroup = new THREE.Group(); scene.add(badgeGroup);
  const FILLS = [0, 0, 0];
  badgeKinds.forEach((k, i) => {
    const g = new THREE.Group();
    g.position.copy(BADGE_C).add(new THREE.Vector3((i - 1) * BADGE_GAP, 0, 0));
    const med = makeMedallion(k); med.scale.setScalar(0.95); g.add(med);
    const mat = new THREE.ShaderMaterial({ uniforms: { uFill: { value: FILLS[i] }, uReveal: { value: 0 }, uTime: { value: 0 } }, vertexShader: ringVert, fragmentShader: ringFrag, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.44, 1.7, 160, 1), mat); ring.position.z = -0.05; g.add(ring);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: '#FF9A0D', transparent: true, opacity: 0.11, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    glow.scale.set(6.5, 6.5, 1); glow.position.z = -0.6; g.add(glow);
    badgeGroup.add(g);
    badges.push({ g, med, mat, fillTarget: FILLS[i] });
  });

  const CAM_Y = 0.3;
  const CAM_Z = [12.5, -27, -156, -189, -236.5, -272];
  const LOOK_DIR = new THREE.Vector3(0, -0.03, -1).normalize();
  function fToZ(f) {
    const i = Math.min(Math.floor(clamp(f, 0, CAM_Z.length - 1)), CAM_Z.length - 2);
    return CAM_Z[i] + (CAM_Z[i + 1] - CAM_Z[i]) * clamp(f - i, 0, 1);
  }
  const cam = { f: 0, mouse: new THREE.Vector2(), mouseS: new THREE.Vector2(), fov: 40 };
  addEventListener('pointermove', (e) => {
    cam.mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
  }, { passive: true });

  const NARROW_DOLLY = [0, 0, 5.5, 2.2, 1.2, 0];
  const STREAM_FADE_FROM = 2.25, STREAM_FADE_SPAN = 0.3;
  const ALT_FADE_FROM = 3.15, ALT_FADE_SPAN = 0.25;
  const CAM_FOLLOW_WALK = 18, CAM_FOLLOW_REST = 3.2;
  const _t = new THREE.Vector3(), _v = new THREE.Vector3();
  function placeCamera(dt, snap) {
    const fTarget = scrollToF(getPageY());
    const follow = isWalking() ? CAM_FOLLOW_WALK : CAM_FOLLOW_REST;
    cam.f = snap ? fTarget : cam.f + (fTarget - cam.f) * (1 - Math.exp(-dt * follow));
    let z = fToZ(cam.f);
    const narrow = clamp((1750 - W) / 470, 0, 1);
    if (narrow > 0) {
      let dolly = 0;
      NARROW_DOLLY.forEach((dl, i) => { dolly += dl * clamp(1 - Math.abs(cam.f - i), 0, 1); });
      z += dolly * narrow;
    }
    cam.mouseS.lerp(cam.mouse, 1 - Math.exp(-dt * 2.5));
    camera.position.set(0, CAM_Y, z);
    camera.lookAt(_t.copy(camera.position).add(LOOK_DIR));
    const gamesW = clamp(1 - Math.abs(cam.f - 1) * 1.5, 0, 1);
    const fovT = 40 + tunFx.kick * 9 * gamesW;
    cam.fov += (fovT - cam.fov) * (1 - Math.exp(-dt * 2.5));
    if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  }

  const badgeLabels = [0, 1, 2].map((i) => $(`#bl${i}`));
  const orbLabels = [$('#orbMainLabel'), $('#orbAltLabel')];
  const ORB_LABEL_W = 180;
  const BADGE_LABEL_MIN_W = 150, BADGE_LABEL_MAX_W = 236, BADGE_LABEL_GAP = 16;
  const BADGE_LABEL_OFFSET = new THREE.Vector3(0, -2.05, 0);
  const ORB_LABEL_OFFSET = new THREE.Vector3(0, -2.2, 0);
  let badgeLabelW = 0;
  function placeLabel(el, world, weight, width) {
    _v.copy(world).project(camera);
    const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
    const o = _v.z < 1 ? weight : 0;
    el.style.opacity = o.toFixed(3);
    el.style.visibility = o > 0.01 ? 'visible' : 'hidden';
    if (o > 0.01) el.style.transform = `translate3d(${(x - width / 2).toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  const tmpQ = new THREE.Vector3();
  function update(dt) {
    T.time += dt;
    const t = T.time;
    updateHeat(dt);
    const f = cam.f;
    const wOf = (i, spread = 1.2) => clamp(1 - Math.abs(f - i) * spread, 0, 1);

    hero.visible = f < 1.7;
    heroFx.speed += (heroFx.speedTarget - heroFx.speed) * (1 - Math.exp(-dt * 2));
    heroFx.spinBoost *= Math.exp(-dt * 1.6);
    heroMeds.forEach((m, i) => {
      const a = t * 0.22 * heroFx.speed + (i * Math.PI * 2) / 3 + heroFx.spinBoost * 0.6;
      m.position.set(HERO_C.x + Math.cos(a) * 1.7, HERO_C.y + Math.sin(a) * 0.42 + Math.sin(t * 0.9 + i) * 0.08, HERO_C.z + Math.sin(a) * 1.35);
      m.rotation.y = t * 0.32 * heroFx.speed + i * 2.1 + heroFx.spinBoost * 6.2832 + cam.mouseS.x * 0.3;
      m.rotation.x = Math.sin(t * 0.6 + i) * 0.12 + cam.mouseS.y * 0.15;
    });
    if (heroFx.shockT >= 0) {
      heroFx.shockT += dt;
      const k = heroFx.shockT / 1.3;
      shock.scale.setScalar(0.8 + k * 7);
      shock.material.opacity = Math.max(0, 1 - k);
      shock.lookAt(camera.position);
      if (k >= 1) heroFx.shockT = -1;
    }

    tunnel.visible = f < 2.7;
    tunFx.speed += (tunFx.speedTarget - tunFx.speed) * (1 - Math.exp(-dt * 1.8));
    tunFx.travel += tunFx.speed * dt;
    tunFx.kick += ((S.games.status === 'running' ? 1 : 0) - tunFx.kick) * (1 - Math.exp(-dt * 2));
    tunFx.waveT += dt;
    tunnelMat.uniforms.uTravel.value = tunFx.travel;
    tunnelMat.uniforms.uTime.value = t;
    tunnelMat.uniforms.uWave.value = tunFx.waveT;
    tunnelMat.uniforms.uVis.value = (0.15 + 0.85 * smooth(clamp(f / 0.8, 0, 1))) * (1 - smooth(clamp((f - 1.7) / 0.28, 0, 1)));
    tunnelEnd.visible = tunnel.visible;
    tunnelEnd.material.opacity = 0.42 * smooth(clamp((f - 0.3) / 0.6, 0, 1)) * (1 - smooth(clamp((f - 1.6) / 0.6, 0, 1)));

    const streamVis = 1 - smooth(clamp((f - STREAM_FADE_FROM) / STREAM_FADE_SPAN, 0, 1));
    stream.visible = f > 0.8 && streamVis > 0.001;
    screenMat.opacity = streamVis;
    screenFrame.material.opacity = streamVis;
    strFx.power += (strFx.powerTarget - strFx.power) * (1 - Math.exp(-dt * 2.2));
    strFx.screenOn += (strFx.screenTarget - strFx.screenOn) * (1 - Math.exp(-dt * 5));
    coneMat.uniforms.uPower.value = strFx.power * streamVis;
    coneMat.uniforms.uTime.value = t;
    hazeMat.uniforms.uPower.value = (0.04 + strFx.power * 0.2) * streamVis;
    poolMat.opacity = (0.06 + strFx.power * 0.22 + strFx.screenOn * 0.08) * streamVis;
    reflMat.opacity = (0.04 + strFx.screenOn * 0.2) * streamVis;
    if (reflMat.map !== screenMat.map) { reflMat.map = screenMat.map; reflMat.needsUpdate = true; }
    refl.scale.y = -screen.scale.y;
    hazeMat.uniforms.uTime.value = t;
    spot.intensity = (40 + strFx.power * 900) * streamVis;
    lamp.material.opacity = (0.15 + strFx.power * 0.7) * streamVis;
    halo.material.opacity = strFx.screenOn * 0.14 * streamVis;
    bezelGlowMat.opacity = (strFx.screenOn * 0.55 + Math.sin(t * 3) * 0.05 * strFx.screenOn) * streamVis;
    screenLight.intensity = strFx.screenOn * 40 * streamVis;
    const on = strFx.screenOn;
    screen.scale.set(1, S.stream.status === 'live' ? Math.max(0.01, smooth(clamp(on * 1.25, 0, 1))) : 1, 1);
    screenMat.color.setScalar(S.stream.status === 'live' ? 1 + Math.max(0, 1 - on * 1.4) * 2.5 : 0.85);
    const previewWanted = S.stream.status === 'live' && S.stream.liveMode === 'video' && stream.visible
      && !document.hidden && !previewFailed && !video.error;
    if (!previewWanted) { if (!video.paused) video.pause(); }
    else if (video.paused) video.play().catch(previewPlayFailed);
    if (S.stream.status === 'live' && S.stream.liveMode === 'silent' && stream.visible && t - strFx.lastDraw > 1 / 20) {
      strFx.lastDraw = t; drawScreen('silent');
    }

    const altVis = 1 - smooth(clamp((f - ALT_FADE_FROM) / ALT_FADE_SPAN, 0, 1));
    const altVisible = f > 2.45 && altVis > 0.001;
    orbMain.g.visible = orbAlt.g.visible = beam.visible = beamGlow.visible = sparks.visible = platform.visible = altVisible;
    platMat.uniforms.uTime.value = t;
    platMat.uniforms.uWatch.value = altFx.watch;
    platMat.uniforms.uBase.value = (0.45 + (S.stream.status === 'live' ? 0.25 : 0) + altFx.watch * 0.3) * altVis;
    const a = S.alt;
    altFx.joined += ((a.status === 'joined' ? 1 : 0) - altFx.joined) * (1 - Math.exp(-dt * 4));
    altFx.watch += ((a.status === 'watching' ? 1 : 0) - altFx.watch) * (1 - Math.exp(-dt * 3));
    const growTarget = a.status === 'idle' ? 0 : 1;
    altFx.grow += (growTarget - altFx.grow) * (1 - Math.exp(-dt * (growTarget ? 1.6 : 4)));
    altFx.altPower += ((a.account === 'in' ? 1 : 0.22) - altFx.altPower) * (1 - Math.exp(-dt * 3));
    [orbMain, orbAlt].forEach((o, i) => {
      o.mat.uniforms.uTime.value = t + i * 3;
      o.g.position.y = (i ? ALT_ALT.y : ALT_MAIN.y) + Math.sin(t * 0.8 + i * 1.7) * 0.15;
      o.ring1.rotation.z = t * (0.3 + i * 0.1);
      o.ring2.rotation.z = -t * (0.22 + i * 0.08);
    });
    const mainPower = 0.75 + (S.stream.status === 'live' ? 0.35 : 0);
    orbMain.mat.uniforms.uPower.value = mainPower * altVis;
    orbMain.glow.material.opacity = (0.2 + (S.stream.status === 'live' ? 0.12 : 0)) * altVis;
    orbMain.ringMat.opacity = 0.7 * altVis;
    const altOn = clamp((altFx.altPower - 0.22) / 0.78, 0, 1);
    orbAlt.mat.uniforms.uColor.value.copy(ALT_IDLE_COLOR).lerp(orbAlt.color, altOn);
    orbAlt.glow.material.color.copy(orbAlt.mat.uniforms.uColor.value);
    orbAlt.ringMat.color.copy(orbAlt.mat.uniforms.uColor.value).multiplyScalar(1.4);
    orbAlt.mat.uniforms.uPower.value = (0.55 + 0.45 * altOn) * (1 + altFx.watch * 0.3) * altVis;
    orbAlt.glow.material.opacity = (0.05 + altFx.altPower * 0.2 + altFx.watch * 0.1) * altVis;
    orbAlt.ringMat.opacity = (0.2 + altOn * 0.5) * altVis;
    beamMat.uniforms.uTime.value = t;
    beamMat.uniforms.uJoined.value = altFx.joined * altVis;
    beamMat.uniforms.uWatch.value = altFx.watch * altVis;
    beamMat.uniforms.uGrow.value = altFx.grow;
    beamGlowMat.uniforms.uWatch.value = altFx.watch * altVis;
    beamGlowMat.uniforms.uGrow.value = altFx.grow;
    sparkMat.opacity = altFx.watch * altVis;
    if (altFx.watch > 0.01) {
      const arr = sparkGeo.attributes.position.array;
      for (let i = 0; i < SPARKS; i++) {
        const u = ((i / SPARKS) + t * 0.22) % 1;
        beamCurve.getPoint(u * altFx.grow, tmpQ);
        arr[i * 3] = tmpQ.x + Math.sin(i * 13.1 + t * 3) * 0.08;
        arr[i * 3 + 1] = tmpQ.y + Math.cos(i * 7.3 + t * 2.6) * 0.08;
        arr[i * 3 + 2] = tmpQ.z;
      }
      sparkGeo.attributes.position.needsUpdate = true;
    }

    badgeGroup.visible = f > 3.3;
    const bw = wOf(4, 1.4);
    badges.forEach((b, i) => {
      b.med.rotation.y = Math.sin(t * 0.5 + i * 1.3) * 0.38;
      b.med.rotation.x = Math.sin(t * 0.4 + i) * 0.06;
      const u = b.mat.uniforms;
      u.uTime.value = t;
      u.uFill.value += (b.fillTarget - u.uFill.value) * (1 - Math.exp(-dt * 3));
      u.uReveal.value += ((bw > 0.4 ? 1 : 0) - u.uReveal.value) * (1 - Math.exp(-dt * (bw > 0.4 ? 1.4 : 3)));
    });
  }

  let snapNext = true;
  function frame(dt) {
    placeCamera(dt, snapNext);
    snapNext = false;
    update(dt);
    const f = cam.f;
    const x0 = _v.copy(badges[0].g.position).project(camera).x;
    const gapPx = _v.z < 1 ? (_v.copy(badges[1].g.position).project(camera).x - x0) * 0.5 * W : 0;
    const labelW = Math.round(clamp(gapPx - BADGE_LABEL_GAP, BADGE_LABEL_MIN_W, BADGE_LABEL_MAX_W));
    if (labelW !== badgeLabelW) {
      badgeLabelW = labelW;
      badgeLabels.forEach((el) => { el.style.width = `${labelW}px`; });
    }
    const bw = clamp(1 - Math.abs(f - 4) * 2.2, 0, 1) * clamp((gapPx - BADGE_LABEL_MIN_W) / 30, 0, 1);
    badges.forEach((b, i) => placeLabel(badgeLabels[i], _t.copy(b.g.position).add(BADGE_LABEL_OFFSET), bw, labelW));
    const aw = clamp(1 - Math.abs(f - 3) * 2.2, 0, 1);
    placeLabel(orbLabels[0], _t.copy(orbMain.g.position).add(ORB_LABEL_OFFSET), aw, ORB_LABEL_W);
    placeLabel(orbLabels[1], _t.copy(orbAlt.g.position).add(ORB_LABEL_OFFSET), aw, ORB_LABEL_W);
    renderer.info.reset();
    composer.render();
    if (fpsEl) {
      fpsAcc.n += 1;
      const nowMs = performance.now();
      if (!fpsAcc.start) fpsAcc.start = nowMs;
      fpsAcc.t = (nowMs - fpsAcc.start) / 1000;
      if (fpsAcc.t >= 0.5) {
        fpsAcc.start = nowMs;
        fpsEl.textContent = `${Math.round(fpsAcc.n / fpsAcc.t)} fps, ${fmt(renderer.info.render.triangles)} triangles, ${renderer.info.render.calls} draw calls, pixel ratio ${DPR}`;
        fpsAcc.n = 0; fpsAcc.t = 0;
      }
    }
  }
  const fpsEl = new URLSearchParams(location.hash.slice(1)).has('fps') ? $('#fps') : null;
  if (fpsEl) fpsEl.hidden = false;
  const fpsAcc = { n: 0, t: 0, start: 0 };

  function resize() {
    W = innerWidth; H = innerHeight;
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    hazeMat.uniforms.uScale.value = H * 0.5;
  }

  const fxApi = {
    connecting() { heroFx.speedTarget = 4; },
    connected() { heroFx.speedTarget = 1; heroFx.spinBoost = 1; heroFx.shockT = 0; heatTo(1); },
    idle() { heroFx.speedTarget = 1; },
    disconnected() { heroFx.speedTarget = 1; heatTo(0); },
    claimStart() { tunFx.speedTarget = 26; },
    claimStop() { tunFx.speedTarget = 1.6; },
    claimDone() { tunFx.speedTarget = 1.6; tunFx.waveT = 0; },
    batchSent() {
      const camZ = camera.position.z;
      for (let tries = 0; tries < 40; tries++) {
        const i = Math.floor(Math.random() * CARDS);
        const z = TUN_FAR + ((((seedArr[i * 4 + 2] - TUN_FAR + tunFx.travel) % TUN_LEN) + TUN_LEN) % TUN_LEN);
        const ang = seedArr[i * 4];
        const sideOk = Math.cos(ang) > -0.2;
        if (z < camZ - 14 && z > camZ - 48 && sideOk) {
          flashAttr.array[i] = T.time;
          flashAttr.needsUpdate = true;
          break;
        }
      }
    },
    streamConnecting() { strFx.powerTarget = 0.3; drawScreen('connecting'); },
    streamLive() { strFx.powerTarget = 1; strFx.screenOn = 0; strFx.screenTarget = 1; this.sync(); },
    streamOff() { strFx.powerTarget = 0.12; strFx.screenTarget = 0; drawScreen('off'); screenMat.map = screenTex; screenMat.needsUpdate = true; video.pause(); },
    badgeFill(i, v) { if (badges[i]) badges[i].fillTarget = v; },
    sync() {
      const st = S.stream;
      if (st.status === 'connecting') drawScreen('connecting');
      if (st.status !== 'live') return;
      const map = st.liveMode === 'video' ? videoTex : screenTex;
      if (screenMat.map !== map) { screenMat.map = map; screenMat.needsUpdate = true; }
      if (st.liveMode !== 'video') drawScreen('silent');
    },
    fromState() {
      if (S.games.status === 'running') { tunFx.speed = tunFx.speedTarget = 26; tunFx.kick = 1; }
      if (S.stream.status === 'live') { strFx.power = strFx.powerTarget = 1; strFx.screenOn = strFx.screenTarget = 1; }
      else if (S.stream.status === 'connecting') { strFx.power = strFx.powerTarget = 0.3; }
      if (S.alt.status === 'watching') { altFx.watch = 1; altFx.grow = 1; altFx.altPower = 1; }
      if (S.alt.status === 'joined') { altFx.joined = 1; altFx.grow = 1; altFx.altPower = 1; }
      if (S.alt.account === 'in') altFx.altPower = 1;
      heatTo(S.account === 'in' ? 1 : 0, true);
      this.sync();
    },
  };

  return { frame, resize, fxApi, setAtlas: (t) => { tunnelMat.uniforms.uAtlas.value = t; }, makeAtlas, drawScreen };
}
