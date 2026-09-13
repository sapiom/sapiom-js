---
"@sapiom/harness": patch
---

Show overall Assistant status separately from completed tools, preserve the answer when completion is unconfirmed, and expose the saved conversation after its Terminal exits. Display bounded continuation progress, reconcile its history, and hide internal completion bookkeeping. Finished reflects the model's explicit report; an unmarked answer remains Stopped and automatic continuation may still produce an unnecessary recap.
