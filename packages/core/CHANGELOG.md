# nominee

## 1.0.0

### Minor Changes

- f1593cf: Approval requests passed to `onApprovalRequest` now carry `approve()`, `deny()`, and `resolve(decision)` methods, so you can settle them inline without capturing the `Nominee` instance (no more self-reference / type-annotation dance). `resolveApproval(id, decision)` still works.
