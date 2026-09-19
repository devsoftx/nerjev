export interface Prf {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1 };
}

export interface MentionVerdict {
  mentionId: string;
  chunkId: string;
  confidence: number;
  accepted: boolean;
  isEntity: boolean;
  boundaryExact: boolean;
  typeCorrect: boolean;
}

export interface RelationVerdict {
  relationId: string;
  chunkId: string;
  confidence: number;
  accepted: boolean;
  supported: boolean;
  typeCorrect: boolean;
  directionCorrect: boolean;
}

export const strictCorrect = (v: MentionVerdict) => v.isEntity && v.boundaryExact && v.typeCorrect;
export const relaxedCorrect = (v: MentionVerdict) => v.isEntity && v.typeCorrect;
export const relationCorrect = (v: RelationVerdict) => v.supported && v.typeCorrect && v.directionCorrect;

/**
 * An extraction that found a real entity but got its boundary or type wrong counts twice, as in
 * standard NER scoring: once as a false positive and once as a miss of the true entity. Recall is an
 * estimate, because the list of misses comes from the judge and not from exhaustive annotation.
 */
export function entityMetrics(verdicts: MentionVerdict[], missed: number, correct: (v: MentionVerdict) => boolean): Prf {
  const accepted = verdicts.filter((v) => v.accepted);
  const tp = accepted.filter(correct).length;
  const wrongButReal = accepted.filter((v) => v.isEntity && !correct(v)).length;
  // A real entity that was only flagged for review is not in the graph, so it is a miss too.
  const heldBack = verdicts.filter((v) => !v.accepted && v.isEntity).length;
  return prf(tp, accepted.length - tp, missed + wrongButReal + heldBack);
}

/** A relation with evidence in several chunks is judged once per chunk and is correct if any chunk supports it. */
export function relationMetrics(verdicts: RelationVerdict[], missed: number): Prf {
  const byRelation = new Map<string, RelationVerdict[]>();
  for (const v of verdicts) byRelation.set(v.relationId, [...(byRelation.get(v.relationId) ?? []), v]);
  let tp = 0;
  let fp = 0;
  let fn = missed;
  for (const group of byRelation.values()) {
    const correct = group.some(relationCorrect);
    const supported = group.some((v) => v.supported);
    if (group[0]!.accepted) {
      if (correct) tp++;
      else {
        fp++;
        if (supported) fn++;
      }
    } else if (supported) fn++;
  }
  return prf(tp, fp, fn);
}

export function typeAccuracy(verdicts: MentionVerdict[]): number | null {
  const real = verdicts.filter((v) => v.accepted && v.isEntity);
  return real.length ? real.filter((v) => v.typeCorrect).length / real.length : null;
}

export interface CalibrationBin {
  from: number;
  to: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface Calibration {
  bins: CalibrationBin[];
  /** Expected calibration error: the count-weighted mean gap between confidence and accuracy. */
  ece: number | null;
  count: number;
}

export function calibration(items: { confidence: number; correct: boolean }[], binCount = 10): Calibration {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const from = i / binCount;
    const to = (i + 1) / binCount;
    const inBin = items.filter((item) => item.confidence >= from && (item.confidence < to || (i === binCount - 1 && item.confidence <= to)));
    if (!inBin.length) continue;
    bins.push({
      from,
      to,
      count: inBin.length,
      meanConfidence: inBin.reduce((sum, item) => sum + item.confidence, 0) / inBin.length,
      accuracy: inBin.filter((item) => item.correct).length / inBin.length,
    });
  }
  const ece = items.length ? bins.reduce((sum, bin) => sum + (bin.count / items.length) * Math.abs(bin.accuracy - bin.meanConfidence), 0) : null;
  return { bins, ece, count: items.length };
}

/** Share of boolean verdicts that two judge passes over the same items agree on. The judge's noise floor. */
export function verdictAgreement(a: Record<string, boolean[]>, b: Record<string, boolean[]>): { agreement: number | null; compared: number } {
  let same = 0;
  let compared = 0;
  for (const [id, first] of Object.entries(a)) {
    const second = b[id];
    if (!second) continue;
    first.forEach((value, i) => {
      if (second[i] === undefined) return;
      compared++;
      if (second[i] === value) same++;
    });
  }
  return { agreement: compared ? same / compared : null, compared };
}
