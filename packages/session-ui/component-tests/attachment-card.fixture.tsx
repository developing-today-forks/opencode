import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AttachmentCard } from "../src/message/attachment-card"

export function mountAttachmentCard() {
  const host = document.createElement("div")
  host.dataset.testid = "attachment-card-fixture"
  document.body.appendChild(host)
  render(() => {
    const [clicks, setClicks] = createSignal(0)

    return (
      <>
        <AttachmentCard title="Clickable card" clickable onClick={() => setClicks((count) => count + 1)}>
          File
        </AttachmentCard>
        <AttachmentCard title="Static card">File</AttachmentCard>
        <output data-testid="attachment-card-clicks">{clicks()}</output>
      </>
    )
  }, host)
}
