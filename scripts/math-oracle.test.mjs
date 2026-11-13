import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_N,
  applyMatrix,
  boundingBox,
  convexIntersectionArea,
  createOracle,
  geometryParameters,
  localSagitta,
  matrixDeterminant,
  maxPairwiseIntersectionArea,
  matrixFromRotationTranslation,
  polygonArea,
  rearrangedPlacement,
  relativeError,
  rigidMatrixDiagnostics,
  sampleCanonicalSector,
  signedPolygonArea,
  totalArea,
  transformVertices,
} from './math-oracle.mjs';

const AREA_TOLERANCE = 2e-5;
const RADIUS = 3.75;

test('exports the requested even n档位 and exact construction parameters', () => {
  assert.deepEqual(SUPPORTED_N, [8, 16, 32, 64]);
  for (const n of SUPPORTED_N) {
    const { alpha, s, c } = geometryParameters(RADIUS, n);
    assert.ok(Math.abs(alpha - Math.PI / n) < Number.EPSILON * 8);
    assert.ok(Math.abs(s - RADIUS * Math.sin(alpha)) < Number.EPSILON * 8);
    assert.ok(Math.abs(c - RADIUS * Math.cos(alpha)) < Number.EPSILON * 8);
  }
});

test('canonical sector has the requested upward tip and correct sampled arc', () => {
  const sector = sampleCanonicalSector(2, 8, 128);
  assert.deepEqual(sector.apex, [0, 0]);
  assert.equal(sector.vertices.length, 130);
  assert.ok(Math.abs(sector.arcStartAngle - (-Math.PI / 2 - Math.PI / 8)) < 1e-12);
  assert.ok(Math.abs(sector.arcEndAngle - (-Math.PI / 2 + Math.PI / 8)) < 1e-12);
  for (const point of sector.arc) {
    assert.ok(Math.abs(Math.hypot(...point) - 2) < 1e-12);
  }
  assert.ok(signedPolygonArea(sector.vertices) > 0);
});

test('every n档位 preserves area through rigid rearrangement', () => {
  for (const n of SUPPORTED_N) {
    const oracle = createOracle({ r: RADIUS, n, arcSamples: 512 });
    const expected = oracle.parameters.circleArea;
    const initialArea = totalArea(oracle.initial);
    const rearrangedArea = totalArea(oracle.rearranged);
    assert.ok(relativeError(initialArea, expected) < AREA_TOLERANCE, `${n}: initial area`);
    assert.ok(relativeError(rearrangedArea, expected) < AREA_TOLERANCE, `${n}: rearranged area`);
    assert.ok(Math.abs(initialArea - rearrangedArea) < 1e-10, `${n}: rearrangement changed area`);
    assert.ok(Math.abs(oracle.initial[0].vertices[0][0]) < 1e-12);
    assert.ok(Math.abs(oracle.initial[0].vertices[0][1]) < 1e-12);
  }
});

test('initial and rearranged transforms are proper rigid matrices', () => {
  for (const n of SUPPORTED_N) {
    const oracle = createOracle({ r: 2.25, n, arcSamples: 64 });
    for (const sector of [...oracle.initial, ...oracle.rearranged]) {
      const diagnostics = rigidMatrixDiagnostics(sector.matrix);
      assert.equal(diagnostics.isRigid, true, `${n}/${sector.index} matrix is not rigid`);
      assert.ok(Math.abs(matrixDeterminant(sector.matrix) - 1) < 1e-10);
      const source = oracle.canonical.vertices[Math.floor(oracle.canonical.vertices.length / 3)];
      const transformed = applyMatrix(sector.matrix, source);
      const transformedAgain = transformVertices([source], sector.matrix)[0];
      assert.deepEqual(transformedAgain, transformed);
    }
  }
});

test('rearranged tips and rotations follow the alternating strip formula', () => {
  const r = 4;
  const n = 16;
  const { s, c } = geometryParameters(r, n);
  for (let i = 0; i < n; i += 1) {
    const placement = rearrangedPlacement(i, r, n);
    const k = Math.floor(i / 2);
    if (i % 2 === 0) {
      assert.deepEqual(placement.tip, [2 * k * s, 0]);
      assert.equal(placement.rotation, 0);
    } else {
      assert.deepEqual(placement.tip, [(2 * k + 1) * s, -c]);
      assert.equal(placement.rotation, Math.PI);
    }
  }
});

test('the final strip has no positive-area polygon overlap', () => {
  // Fewer arc samples are enough for the topological check and keep clipping
  // cheap; area accuracy is tested separately at 512 samples.
  for (const n of SUPPORTED_N) {
    const oracle = createOracle({ r: 2.5, n, arcSamples: 64 });
    const overlap = maxPairwiseIntersectionArea(oracle.rearranged);
    assert.ok(overlap < 1e-9, `${n}: pairwise overlap ${overlap}`);
    for (let i = 0; i < oracle.rearranged.length - 1; i += 1) {
      const adjacent = convexIntersectionArea(
        oracle.rearranged[i].vertices,
        oracle.rearranged[i + 1].vertices,
      );
      assert.ok(adjacent < 1e-9, `${n}: adjacent overlap ${adjacent}`);
    }
  }
});

test('local arc sagitta decreases as the sector count doubles', () => {
  const sagitta = SUPPORTED_N.map((n) => localSagitta(10, n));
  for (let i = 1; i < sagitta.length; i += 1) {
    assert.ok(sagitta[i] < sagitta[i - 1], `${SUPPORTED_N[i]} sagitta did not decrease`);
  }
  assert.ok(sagitta.at(-1) / sagitta[0] < 0.02);
});

test('bounding boxes expose a finite near-rectangle without claiming exactness', () => {
  const oracle = createOracle({ r: 1, n: 64, arcSamples: 32 });
  const box = boundingBox(oracle.rearranged.flatMap((sector) => sector.vertices));
  assert.ok(box.width > 2.9 && box.width < 3.2, `unexpected width ${box.width}`);
  assert.ok(box.height > 0.95 && box.height < 1.1, `unexpected height ${box.height}`);
  assert.ok(Number.isFinite(box.width * box.height));
});

