/**
 * Helix Wireframe — vanilla JS build, no framework dependency. Requires
 * three.js (r128) loaded globally as THREE before this file runs.
 *
 * Usage: call HelixWireframe.init('helix-wireframe-mount') once the target
 * element exists in the DOM. init() is guarded against being called twice
 * on the same element, and returns a destroy() function you can call if
 * you ever need to tear it down early.
 *
 * Proportions are tuned long and thin, meant to sit in a narrow column
 * next to text (see index.html) or fill a portrait/phone canvas.
 *
 * Interaction model: rotation is mostly autonomous — it "wanders": every
 * several seconds it picks a new nearby target for its spin speed and
 * tilt, then eases toward that target over the following seconds, so
 * direction and pace drift organically without ever snapping or jerking.
 * On top of that, mouse position on the page nudges the tilt/spin
 * slightly toward wherever the cursor is — a gentle lean, not a drag —
 * so it doesn't spin wildly on an accidental mouse move. The scroll
 * wheel still drives zoom.
 */
(function (global) {
  "use strict";

  function init(mountId) {
    var mount = document.getElementById(mountId);
    if (!mount) {
      console.warn("HelixWireframe: no element with id \"" + mountId + "\"");
      return null;
    }
    if (mount.dataset.helixInitialized === "true") {
      // Already running on this element (e.g. region refresh fired twice) —
      // don't spin up a second WebGL context on top of it.
      return null;
    }
    mount.dataset.helixInitialized = "true";

    if (typeof THREE === "undefined") {
      console.error(
        "HelixWireframe: three.js (THREE) is not loaded. Add the three.js " +
          "script include before this file runs."
      );
      return null;
    }

    // ---------- scene / camera / renderer ----------
    var scene = new THREE.Scene();

    var CAMERA_Z = 14;
    var camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      300
    );
    camera.position.set(0, 0, CAMERA_Z);

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    var group = new THREE.Group();
    scene.add(group);

    // ---------- domain watermark ----------
    // A plain HTML overlay rather than a 3D texture — stays pixel-crisp at
    // any resolution/DPR and costs nothing in the render loop. Runs
    // vertically up the right edge to sit with the tall/thin composition
    // rather than fighting it with a horizontal line of text.
    var computedPosition = window.getComputedStyle(mount).position;
    if (computedPosition === "static") {
      // Only set this if the page hasn't already positioned the mount —
      // an absolute child needs *a* positioned ancestor, but we shouldn't
      // clobber a value the host page deliberately set.
      mount.style.position = "relative";
    }
    var watermark = document.createElement("div");
    watermark.textContent = "jmclare.com   ".repeat(8);
    watermark.style.position = "absolute";
    watermark.style.top = "0";
    watermark.style.right = "6px";
    watermark.style.height = "100%";
    watermark.style.writingMode = "vertical-rl";
    watermark.style.textOrientation = "mixed";
    watermark.style.overflow = "hidden";
    watermark.style.fontFamily = "monospace";
    watermark.style.fontSize = "11px";
    watermark.style.letterSpacing = "0.25em";
    watermark.style.color = "#B7C2CC";
    watermark.style.opacity = "0.38";
    watermark.style.fontWeight = "bold";
    watermark.style.pointerEvents = "none"; // never intercepts the wheel/mouse handlers below
    watermark.style.userSelect = "none";
    watermark.style.whiteSpace = "nowrap";
    mount.appendChild(watermark);

    // ---------- circular sprite texture so points render as round atoms ----------
    function makeCircleTexture() {
      var size = 64;
      var canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext("2d");
      var grad = ctx.createRadialGradient(
        size / 2, size / 2, 0,
        size / 2, size / 2, size / 2
      );
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.55, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();
      var tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
    var circleTexture = makeCircleTexture();

    // ---------- helix geometry (as particle positions) ----------
    // Tuned long and thin for a portrait/phone canvas: taller, tighter
    // radius, more turns for a denser coil, and more points so spacing
    // along the strand doesn't thin out now that it's longer.
    var TURNS = 4;
    var HEIGHT = 46;
    var RADIUS = 1.5;
    var COUNT = 200;

    var INDIGO = new THREE.Color("#2C3E66");
    var TEAL = new THREE.Color("#0E9C82");
    var RUNG_COLOR = new THREE.Color("#B7C2CC");

    function formedStrand(phaseOffset) {
      var pts = [];
      for (var i = 0; i < COUNT; i++) {
        var t = i / (COUNT - 1);
        var angle = t * Math.PI * 2 * TURNS + phaseOffset;
        var x = Math.cos(angle) * RADIUS;
        var z = Math.sin(angle) * RADIUS;
        var y = (t - 0.5) * HEIGHT;
        pts.push(new THREE.Vector3(x, y, z));
      }
      return pts;
    }
    var formedA = formedStrand(0);
    var formedB = formedStrand(Math.PI);

    // Each atom scatters outward from its own position on the helix,
    // rather than to an unrelated random point in space. That correlation
    // is what makes the reform look fluid (every atom is retracing
    // roughly its own path home) instead of unrelated particles
    // converging from arbitrary places.
    function scatteredFromFormed(formedPts, spread) {
      var pts = [];
      for (var i = 0; i < formedPts.length; i++) {
        var f = formedPts[i];
        var radialLen = Math.sqrt(f.x * f.x + f.z * f.z) || 1;
        var dirX = f.x / radialLen;
        var dirZ = f.z / radialLen;
        var outward = spread * (1.2 + Math.random() * 1.4);
        pts.push(
          new THREE.Vector3(
            f.x + dirX * outward,
            f.y + (Math.random() * 2 - 1) * spread * 0.4,
            f.z + dirZ * outward
          )
        );
      }
      return pts;
    }
    var scatteredA = scatteredFromFormed(formedA, 4);
    var scatteredB = scatteredFromFormed(formedB, 4);

    function driftSeeds(n) {
      var seeds = [];
      for (var i = 0; i < n; i++) {
        seeds.push({
          fx: Math.random() * Math.PI * 2,
          fy: Math.random() * Math.PI * 2,
          fz: Math.random() * Math.PI * 2,
          speed: 0.3 + Math.random() * 0.4,
          amp: 0.25 + Math.random() * 0.35,
        });
      }
      return seeds;
    }
    var driftA = driftSeeds(COUNT);
    var driftB = driftSeeds(COUNT);

    function makePointCloud(color, size) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(new Float32Array(COUNT * 3), 3)
      );
      var mat = new THREE.PointsMaterial({
        color: color,
        size: size,
        map: circleTexture,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      });
      return new THREE.Points(geo, mat);
    }

    var BASE_POINT_SIZE = 0.22;
    var pointsA = makePointCloud(INDIGO, BASE_POINT_SIZE);
    var pointsB = makePointCloud(TEAL, BASE_POINT_SIZE);
    group.add(pointsA, pointsB);

    // 6 rungs per turn keeps the angular spacing between them constant and
    // repeating. TURNS * 60 (150 rungs across 140 points) is close to a
    // rung at nearly every atom — a solid cross-hatched ribbon rather than
    // a sparse ladder. Not "too much" as such, just a stylistic choice; if
    // you want it airier, dropping toward TURNS * 6 (15) gives clean gaps
    // between rungs while keeping the same even spacing.
    var RUNG_COUNT = Math.round(TURNS * 60);
    var rungGeo = new THREE.BufferGeometry();
    rungGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(RUNG_COUNT * 2 * 3), 3)
    );
    var rungMat = new THREE.LineBasicMaterial({
      color: RUNG_COLOR,
      transparent: true,
      opacity: 0,
    });
    var rungs = new THREE.LineSegments(rungGeo, rungMat);
    group.add(rungs);

    var rungIndices = [];
    for (var ri = 0; ri < RUNG_COUNT; ri++) {
      rungIndices.push(Math.floor((ri / (RUNG_COUNT - 1)) * (COUNT - 1)));
    }

    // ---------- form / dissolve timeline ----------
    function smooth(x) { return x * x * (3 - 2 * x); }

    var HOLD_FORMED = 24;
    var DISSOLVE = 6;
    var HOLD_SCATTERED = 8;
    var REFORM = 8;
    var PERIOD = HOLD_FORMED + DISSOLVE + HOLD_SCATTERED + REFORM;

    function formAmountAt(seconds) {
      var t = seconds % PERIOD;
      if (t < HOLD_FORMED) return 1;
      if (t < HOLD_FORMED + DISSOLVE) return 1 - smooth((t - HOLD_FORMED) / DISSOLVE);
      if (t < HOLD_FORMED + DISSOLVE + HOLD_SCATTERED) return 0;
      var reformT = t - (HOLD_FORMED + DISSOLVE + HOLD_SCATTERED);
      return smooth(reformT / REFORM);
    }

    // ---------- autonomous rotation: slow, self-directed "wander" ----------
    // Every WANDER_MIN–WANDER_MAX seconds it rolls a new nearby target for
    // spin speed (around Y) and a small tilt (X and Z), then eases the
    // live values toward those targets a little each frame. Because the
    // easing is slow and continuous, the motion drifts rather than jumps —
    // there's no single frame where it visibly changes direction or pace.
    var BASE_SPEED = 0.5; // rad/s, the speed it wanders around
    var SPEED_VARIANCE = 0.18; // +/- range for the wandering target
    var TILT_RANGE = 0.16; // radians, how far it can lean while wandering
    var WANDER_MIN = 5; // seconds between retargeting
    var WANDER_MAX = 11;
    var WANDER_EASE = 0.006; // per-frame ease toward the current target

    // Extra spin added only while dissolving/reforming. 4*form*(1-form) is
    // a smooth bump: 0 at fully-formed (form=1) and fully-scattered
    // (form=0), peaking at 1 exactly mid-transition — so this ramps the
    // boost up and back down on its own, no separate easing needed and no
    // chance of a visible jump at either end.
    var TRANSITION_SPIN_BOOST = 2.4; // rad/s added at the peak of a transition

    var autoAngle = 0;
    var spinSpeed = BASE_SPEED;
    var spinSpeedTarget = BASE_SPEED;
    var tiltX = 0;
    var tiltXTarget = 0;
    var tiltZ = 0;
    var tiltZTarget = 0;
    var nextWanderAt = 0;

    function maybeRetarget(elapsed) {
      if (elapsed < nextWanderAt) return;
      spinSpeedTarget = BASE_SPEED + (Math.random() * 10 - 1) * SPEED_VARIANCE;
      tiltXTarget = (Math.random() * 5 - 1) * TILT_RANGE;
      tiltZTarget = (Math.random() * 5 - 1) * TILT_RANGE;
      nextWanderAt = elapsed + WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
    }

    // ---------- interaction: mouse nudge, device tilt, and scroll-wheel zoom ----------
    // The mouse never drives rotation directly (no per-pixel drag speed to
    // spin wildly on an accidental twitch). Instead its position on the
    // whole page is tracked as a normalised -1..1 value, smoothed with its
    // own slow ease (MOUSE_EASE), and added on top of the autonomous
    // wander as a small constant lean toward wherever the cursor is — so
    // holding the mouse in a corner just tilts the helix gently that way
    // and adds a touch of spin, rather than driving it.
    //
    // On touch devices there's no mouse, so device orientation (tilt)
    // feeds into the exact same mouseRawX/mouseRawY variables via the
    // same normalise-and-ease pipeline below — physically tilting the
    // phone left/right or forward/back does the same job holding the
    // cursor in a corner does on desktop.
    var mouseRawX = 0, mouseRawY = 0; // last raw reading (mouse OR tilt), -1..1
    var mouseX = 0, mouseY = 0; // eased, what actually gets used
    var MOUSE_EASE = 0.045;
    var MOUSE_TILT_STRENGTH = 0.22; // radians of extra tilt at full deflection
    var MOUSE_SPIN_STRENGTH = 0.45; // rad/s of extra spin at full deflection

    function handleMouseMove(e) {
      mouseRawX = (e.clientX / window.innerWidth) * 2 - 1;
      mouseRawY = (e.clientY / window.innerHeight) * 2 - 1;
    }
    // Listens on the whole document, not just the mount, so the lean
    // responds to where the cursor is on the page generally rather than
    // only while it's directly over the widget.
    document.addEventListener("mousemove", handleMouseMove);

    // Tilt is tracked relative to whatever orientation the phone happened
    // to be in on the very first reading, not to "flat on a table" — most
    // people browse holding a phone at some resting angle already, and
    // measuring from that baseline means a first gentle tilt registers
    // immediately instead of fighting through however they were already
    // holding it. /30 means a ~30 degree tilt from that starting point
    // reaches full deflection — deliberately easy to trigger so it reads
    // as clearly connected to the phone's movement, not a subtle easter egg.
    var orientationBaseBeta = null;
    var orientationBaseGamma = null;
    function handleOrientation(e) {
      if (e.beta == null || e.gamma == null) return;
      if (orientationBaseBeta === null) {
        orientationBaseBeta = e.beta;
        orientationBaseGamma = e.gamma;
      }
      mouseRawY = THREE.MathUtils.clamp((e.beta - orientationBaseBeta) / 30, -1, 1);
      mouseRawX = THREE.MathUtils.clamp((e.gamma - orientationBaseGamma) / 30, -1, 1);
    }
    var orientationGateHandler = null;
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      // iOS 13+ requires a user gesture before it will grant motion access
      // — can't just start listening on load. Requests permission on the
      // first tap/touch anywhere on the page.
      orientationGateHandler = function () {
        DeviceOrientationEvent.requestPermission()
          .then(function (state) {
            if (state === "granted") {
              window.addEventListener("deviceorientation", handleOrientation);
            }
          })
          .catch(function () {});
      };
      document.addEventListener("touchend", orientationGateHandler, { once: true });
    } else if (typeof window.DeviceOrientationEvent !== "undefined") {
      window.addEventListener("deviceorientation", handleOrientation);
    }

    var MIN_SCALE = 0.5;
    var MAX_SCALE = 1.2;
    var zoomTarget = 1;
    var zoomScale = 1;

    function handleWheel(e) {
      e.preventDefault();
      var factor = Math.exp(-e.deltaY * 0.001);
      zoomTarget = THREE.MathUtils.clamp(zoomTarget * factor, MIN_SCALE, MAX_SCALE);
    }
    mount.addEventListener("wheel", handleWheel, { passive: false });

    // ---------- resize ----------
    var resizeObserver = new ResizeObserver(function () {
      var w = mount.clientWidth;
      var h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(mount);

    // ---------- animation loop ----------
    var rafId;
    var clock = new THREE.Clock();
    var elapsed = 0;
    var running = true;

    var posA = pointsA.geometry.attributes.position;
    var posB = pointsB.geometry.attributes.position;
    var rungPos = rungs.geometry.attributes.position;

    function updateStrand(posAttr, formed, scattered, drift, form, t) {
      for (var i = 0; i < COUNT; i++) {
        var f = formed[i];
        var s = scattered[i];
        var d = drift[i];
        var driftX = Math.sin(t * d.speed + d.fx) * d.amp * (1 - form);
        var driftY = Math.cos(t * d.speed * 0.8 + d.fy) * d.amp * (1 - form);
        var driftZ = Math.sin(t * d.speed * 1.2 + d.fz) * d.amp * (1 - form);

        var x = THREE.MathUtils.lerp(s.x, f.x, form) + driftX;
        var y = THREE.MathUtils.lerp(s.y, f.y, form) + driftY;
        var z = THREE.MathUtils.lerp(s.z, f.z, form) + driftZ;

        posAttr.setXYZ(i, x, y, z);
      }
      posAttr.needsUpdate = true;
    }

    function animate() {
      if (!running) return;
      rafId = requestAnimationFrame(animate);
      var dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;

      var form = formAmountAt(elapsed);

      updateStrand(posA, formedA, scatteredA, driftA, form, elapsed);
      updateStrand(posB, formedB, scatteredB, driftB, form, elapsed);

      for (var i = 0; i < RUNG_COUNT; i++) {
        var idx = rungIndices[i];
        var ax = posA.getX(idx), ay = posA.getY(idx), az = posA.getZ(idx);
        var bx = posB.getX(idx), by = posB.getY(idx), bz = posB.getZ(idx);
        rungPos.setXYZ(i * 2, ax, ay, az);
        rungPos.setXYZ(i * 2 + 1, bx, by, bz);
      }
      rungPos.needsUpdate = true;
      rungMat.opacity = Math.max(0, (form - 0.6) / 0.4) * 0.5;

      zoomScale = THREE.MathUtils.lerp(zoomScale, zoomTarget, 0.08);
      group.scale.setScalar(zoomScale);

      var zoomSizeFactor = Math.pow(zoomScale, 0.55);
      var dispersedSwell = 1 + (1 - form) * 0.25;
      var pointSize = BASE_POINT_SIZE * zoomSizeFactor * dispersedSwell;
      pointsA.material.size = pointSize;
      pointsB.material.size = pointSize;

      // autonomous wander: occasionally pick a new nearby target, always
      // ease toward it gently — never jump straight there. Retargeting is
      // paused while mid-dissolve/reform (0 < form < 1) so the transition
      // itself doesn't get disturbed by a mid-flight change of direction;
      // it simply resumes wandering once form settles back to 0 or 1.
      if (form === 0 || form === 1) {
        maybeRetarget(elapsed);
      }
      spinSpeed = THREE.MathUtils.lerp(spinSpeed, spinSpeedTarget, WANDER_EASE);
      tiltX = THREE.MathUtils.lerp(tiltX, tiltXTarget, WANDER_EASE);
      tiltZ = THREE.MathUtils.lerp(tiltZ, tiltZTarget, WANDER_EASE);

      // mouse nudge: ease the tracked pointer position itself (so a sudden
      // jump across the screen doesn't slam the lean either), then blend
      // it in as a small addition on top of the wander — it never
      // replaces tiltX/tiltZ/spinSpeed, only nudges the final values.
      mouseX = THREE.MathUtils.lerp(mouseX, mouseRawX, MOUSE_EASE);
      mouseY = THREE.MathUtils.lerp(mouseY, mouseRawY, MOUSE_EASE);

      var transitionBump = 4 * form * (1 - form); // 0..1, peaks mid-transition
      autoAngle += dt * (
        spinSpeed +
        transitionBump * TRANSITION_SPIN_BOOST +
        mouseX * MOUSE_SPIN_STRENGTH
      );

      group.rotation.y = autoAngle;
      group.rotation.x = tiltX + mouseY * MOUSE_TILT_STRENGTH;
      group.rotation.z = tiltZ + mouseX * MOUSE_TILT_STRENGTH * 0.5;

      renderer.render(scene, camera);
    }
    animate();

    function destroy() {
      running = false;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      mount.removeEventListener("wheel", handleWheel);
      document.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("deviceorientation", handleOrientation);
      if (orientationGateHandler) {
        document.removeEventListener("touchend", orientationGateHandler);
      }
      pointsA.geometry.dispose();
      pointsA.material.dispose();
      pointsB.geometry.dispose();
      pointsB.material.dispose();
      rungGeo.dispose();
      rungMat.dispose();
      circleTexture.dispose();
      renderer.dispose();
      if (watermark.parentNode === mount) {
        mount.removeChild(watermark);
      }
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      mount.dataset.helixInitialized = "false";
    }

    return destroy;
  }

  global.HelixWireframe = { init: init };
})(window);