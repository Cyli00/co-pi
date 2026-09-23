import { Type } from "typebox";
import {
  HANDOFF_ARRAY_MAX, HANDOFF_EVIDENCE_PATH_MAX, HANDOFF_NEXT_STEPS_MAX, HANDOFF_STATUSES,
  HANDOFF_TEXT_MAX, HANDOFF_TEXT_MIN, VERIFICATION_RESULTS,
} from "./handoff-contract.js";

const text = Type.String({ minLength: HANDOFF_TEXT_MIN, maxLength: HANDOFF_TEXT_MAX });
export const handoffParameters = Type.Object({
  status: Type.Enum(HANDOFF_STATUSES),
  summary: text,
  changes: Type.Array(text, { maxItems: HANDOFF_ARRAY_MAX }),
  verification: Type.Array(Type.Object({
    action: text,
    result: Type.Enum(VERIFICATION_RESULTS),
    detail: text,
  }, { additionalProperties: false }), { maxItems: HANDOFF_ARRAY_MAX }),
  evidence: Type.Array(Type.Object({
    path: Type.String({ minLength: HANDOFF_TEXT_MIN, maxLength: HANDOFF_EVIDENCE_PATH_MAX }),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    note: text,
  }, { additionalProperties: false }), { maxItems: HANDOFF_ARRAY_MAX }),
  unresolved: Type.Array(text, { maxItems: HANDOFF_ARRAY_MAX }),
  nextSteps: Type.Array(text, { maxItems: HANDOFF_NEXT_STEPS_MAX }),
}, { additionalProperties: false });
