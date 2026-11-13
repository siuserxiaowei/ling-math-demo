/**
 * A small, renderer-independent geometry oracle for the circle-area animation.
 *
 * Coordinates use the usual mathematical convention (positive y is up).  The
 * canonical sector has its tip at the origin and its circular arc below it:
 * the arc runs from -PI/2 - alpha to -PI/2 + alpha.  The shape therefore
 * looks like an upward-pointing wedge in the animation.
 */

export const SUPPORTED_N = Object.freeze([8, 16, 32, 64]);
export const TAU = Math.PI * 2;

const DEFAULT_ARC_SAMPLES = 512;
const EPSILON = 1e-12;

function assertFinitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

export function validateN(n) {
  if (!Number.isInteger(n) || !SUPPORTED_N.includes(n)) {
    throw new RangeError(`n must be one of ${SUPPORTED_N.join(', ')}`);
  }
  return n;
}

export function validateArcSamples(arcSamples) {
  if (!Number.isInteger(arcSamples) || arcSamples < 8) {
    throw new RangeError('arcSamples must be an integer >= 8');
  }
  return arcSamples;
}

export function geometryParameters(r, n) {
  assertFinitePositive(r, 'r');
  validateN(n);
  const alpha = Math.PI / n;
  return Object.freeze({
    r,
    n,
    alpha,
    s: r * Math.sin(alpha),
    c: r * Math.cos(alpha),
    sectorAngle: 2 * alpha,
    sectorArea: (Math.PI * r * r) / n,
    circleArea: Math.PI * r * r,
    localSagitta: r * (1 - Math.cos(alpha)),
  });
}

export function sampleCanonicalSector(r, n, arcSamples = DEFAULT_ARC_SAMPLES) {
  const params = geometryParameters(r, n);
  validateArcSamples(arcSamples);
  const startAngle = -Math.PI / 2 - params.alpha;
  const endAngle = -Math.PI / 2 + params.alpha;
  const arc = [];
  for (let j = 0; j <= arcSamples; j += 1) {
    const theta = startAngle + ((endAngle - startAngle) * j) / arcSamples;
    arc.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }

  return Object.freeze({
    apex: [0, 0],
    arc,
    vertices: [[0, 0], ...arc],
    arcStartAngle: startAngle,
    arcEndAngle: endAngle,
    arcSamples,
    ...params,
  });
}

/**
 * A 3x3 homogeneous rigid transform.  The final column is translation.
 */
export function matrixFromRotationTranslation(rotation, tx = 0, ty = 0) {
  if (![rotation, tx, ty].every(Number.isFinite)) {
    throw new TypeError('rotation and translation must be finite numbers');
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [
    [cos, -sin, tx],
    [sin, cos, ty],
    [0, 0, 1],
  ];
}

export function applyMatrix(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 3 || matrix.some((row) => !Array.isArray(row) || row.length !== 3)) {
    throw new TypeError('matrix must be a 3x3 array');
  }
  const [x, y] = point;
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2],
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2],
  ];
}

export function transformVertices(vertices, matrix) {
  return vertices.map((point) => applyMatrix(matrix, point));
}

export function matrixDeterminant(matrix) {
  return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
}

export function rigidMatrixDiagnostics(matrix) {
  const a = matrix[0][0];
  const b = matrix[0][1];
  const c = matrix[1][0];
  const d = matrix[1][1];
  const firstColumnNormError = Math.abs(a * a + c * c - 1);
  const secondColumnNormError = Math.abs(b * b + d * d - 1);
  const orthogonalityError = Math.abs(a * b + c * d);
  const determinant = matrixDeterminant(matrix);
  return {
    determinant,
    firstColumnNormError,
    secondColumnNormError,
    orthogonalityError,
    isRigid: firstColumnNormError < 1e-10
      && secondColumnNormError < 1e-10
      && orthogonalityError < 1e-10
      && Math.abs(determinant - 1) < 1e-10,
  };
}

function assertIndex(i, n) {
  if (!Number.isInteger(i) || i < 0 || i >= n) {
    throw new RangeError(`sector index must be an integer in [0, ${n - 1}]`);
  }
}

export function initialPlacement(i, r, n) {
  const params = geometryParameters(r, n);
  assertIndex(i, n);
  const rotation = i * TAU / n;
  return Object.freeze({
    index: i,
    rotation,
    tip: [0, 0],
    matrix: matrixFromRotationTranslation(rotation),
    ...params,
  });
}

export function rearrangedPlacement(i, r, n) {
  const params = geometryParameters(r, n);
  assertIndex(i, n);
  const k = Math.floor(i / 2);
  const even = i % 2 === 0;
  const rotation = even ? 0 : Math.PI;
  const tip = even
    ? [2 * k * params.s, 0]
    : [(2 * k + 1) * params.s, -params.c];
  return Object.freeze({
    index: i,
    k,
    parity: even ? 'even' : 'odd',
    rotation,
    tip,
    matrix: matrixFromRotationTranslation(rotation, tip[0], tip[1]),
    ...params,
  });
}

function materializeSector(placement, canonicalVertices) {
  return Object.freeze({
    index: placement.index,
    k: placement.k,
    parity: placement.parity,
    rotation: placement.rotation,
    tip: placement.tip,
    matrix: placement.matrix,
    vertices: transformVertices(canonicalVertices, placement.matrix),
  });
}

export function createOracle({ r = 1, n, arcSamples = DEFAULT_ARC_SAMPLES } = {}) {
  const canonical = sampleCanonicalSector(r, n, arcSamples);
  const initial = [];
  const rearranged = [];
  for (let i = 0; i < n; i += 1) {
    initial.push(materializeSector(initialPlacement(i, r, n), canonical.vertices));
    rearranged.push(materializeSector(rearrangedPlacement(i, r, n), canonical.vertices));
  }
  return Object.freeze({
    parameters: geometryParameters(r, n),
    canonical,
    initial: Object.freeze(initial),
    rearranged: Object.freeze(rearranged),
  });
}

export function signedPolygonArea(vertices) {
  let twiceArea = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

export function polygonArea(vertices) {
  return Math.abs(signedPolygonArea(vertices));
}

export function totalArea(sectors) {
  return sectors.reduce((sum, sector) => sum + polygonArea(sector.vertices ?? sector), 0);
}

export function relativeError(actual, expected) {
  assertFinitePositive(Math.abs(expected), 'expected magnitude');
  return Math.abs(actual - expected) / Math.abs(expected);
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function lineIntersection(p1, p2, q1, q2) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]];
  const s = [q2[0] - q1[0], q2[1] - q1[1]];
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < EPSILON) return p2;
  const qp = [q1[0] - p1[0], q1[1] - p1[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denominator;
  return [p1[0] + t * r[0], p1[1] + t * r[1]];
}

function clipConvexPolygon(subject, clipper) {
  let output = subject.slice();
  for (let i = 0; i < clipper.length && output.length > 0; i += 1) {
    const edgeStart = clipper[i];
    const edgeEnd = clipper[(i + 1) % clipper.length];
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentInside = cross(edgeStart, edgeEnd, current) >= -EPSILON;
      const previousInside = cross(edgeStart, edgeEnd, previous) >= -EPSILON;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
      }
      if (currentInside) output.push(current);
    }
  }
  return output;
}

export function convexIntersectionArea(verticesA, verticesB) {
  if (verticesA.length < 3 || verticesB.length < 3) return 0;
  const clipper = signedPolygonArea(verticesB) >= 0 ? verticesB : [...verticesB].reverse();
  return polygonArea(clipConvexPolygon(verticesA, clipper));
}

export function maxPairwiseIntersectionArea(sectors) {
  let maxArea = 0;
  for (let i = 0; i < sectors.length; i += 1) {
    for (let j = i + 1; j < sectors.length; j += 1) {
      maxArea = Math.max(maxArea, convexIntersectionArea(sectors[i].vertices ?? sectors[i], sectors[j].vertices ?? sectors[j]));
    }
  }
  return maxArea;
}

export function localSagitta(r, n) {
  return geometryParameters(r, n).localSagitta;
}

export function boundingBox(vertices) {
  const xs = vertices.map(([x]) => x);
  const ys = vertices.map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

