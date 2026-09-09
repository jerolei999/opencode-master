import { expect, test } from "bun:test"
import { webAppHtml } from "../src/http/web-console"

test("renders a workspace UI with resilient chat controls", () => {
  const html = webAppHtml()
  expect(html).toContain('class="app-shell"')
  expect(html).toContain('id="connectionState"')
  expect(html).toContain('id="newSession"')
  expect(html).toContain('id="composer"')
  expect(html).toContain('id="sendButton"')
  expect(html).toContain('id="toastRegion"')
  expect(html).toContain('function renderTool')
  expect(html).toContain('function setConnectionState')
  expect(html).toContain('.main{min-width:0;min-height:0;')
  expect(html).toContain('.message-scroller{min-height:0;overflow:auto;')
})

test("resumes an event stream from the last consumed event and ignores a replayed question", () => {
  const html = webAppHtml()
  expect(html).toContain('let lastEventID=null,displayedQuestionIDs=new Set();')
  expect(html).toContain('headers:{authorization:"Bearer "+token,...(lastEventID?{"last-event-id":lastEventID}:{})}')
  expect(html).toContain('displayedQuestionIDs.has(interaction.id))return;')
  expect(html).toContain('if(line.startsWith("id: "))lastEventID=line.slice(4).trim()')
  expect(html).toContain('event?.type==="worker.question.resolved"')
  expect(html).toContain('document.getElementById("question-"+data.interactionID)?.remove()')
})
