# Decision classes

Use these questions when an issue's requirements leave a meaningful choice.
Investigate the current code and recorded rulings before asking the owner. The
[filing procedure](../../.claude/skills/file-issue/SKILL.md) owns issue preparation;
[dispatch](dispatch.md) owns readiness and dependencies. Follow the
[change and test policy](../change-policy.md): ask only what affects the result,
and keep the evidence concise.

## Ask at filing

| Uncertainty                     | Evidence needed before implementation                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Two readings of one requirement | Restate the proposed behavior in the acceptance criteria's terms. Identify where two valid implementations would differ. |
| Placement                       | Name the surface, position, and existing control or content that yields to the addition.                                 |
| A number                        | Reuse its owning constant, cite a measurement, or identify it as an unresolved assumption.                               |
| Wrong-result cost               | State what a false positive loses and whether undo reaches it. Specify the refusal behavior for destructive ambiguity.   |
| Conflicting rulings             | Search by the affected component or model. Present both current rulings and the concrete conflict.                       |
| Coupled issues                  | Identify shared files or behavior and the landing order; record dependencies explicitly.                                 |
| An “every X” rule               | Name its covered surfaces and real exceptions. Check whether a shared owner can express the boundary.                    |

Resolve routine implementation choices from existing contracts. For a material
owner choice, provide two or three concrete options with costs and a recommended
direction. A question can be tracked with the appropriate owner gate; filing it
does not authorize implementation of an unanswered design.

## When one still reaches the owner

Visual placement or hierarchy choices need rendered alternatives at mobile and
desktop widths (390 and 1280), with the relevant state visible. Keep the question
short and point to the observable difference.

When posting screenshots is authorized, commit synthetic or appropriately
redacted PNGs under `screenshots/<issue>/` on the lane's branch, push it, and embed
SHA-pinned raw URLs in the GitHub comment. Keep the branch while the images are
needed. A private session or artifact-page link does not make the evidence visible
to the issue's readers.

## Not catchable at filing

Owner amendments after seeing the product and measured discoveries can change a
previously sound premise. Record the changed requirement or evidence, preserve
completed work, and reassess the remaining scope before continuing. Do not turn
an amendment into an incident narrative or silently broaden the task.

Route unresolved product decisions through [owner-question handling](labels.md).
The PM owns process coordination; agents apply current domain contracts and report
findings outside their decision scope.
