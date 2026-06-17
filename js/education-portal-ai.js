const API_URL = "/api/education-portal-chat";

const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const followUpBtn = document.getElementById("followUpBtn");
const clearBtn = document.getElementById("clearBtn");
const clearBtnTop = document.getElementById("clearBtnTop");
const expandBtn = document.getElementById("assistantExpandToggle");
const popoutBtn = document.getElementById("assistantPopoutToggle");
const modalBackdrop = document.getElementById("assistantModalBackdrop");
const assistantCard = document.querySelector(".assistantCard");
const typingIndicator = document.getElementById("typingIndicator");
const thinkingOrb = document.getElementById("thinkingOrb");
const assistantStateText = document.getElementById("assistantStateText");
const chips = document.querySelectorAll(".chip");

let history = [];
let lastUserQuestion = "";
let isExpanded = false;
let isModalOpen = false;

function scrollToBottom() {
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function syncAssistantLayout() {
  if (!assistantCard) return;
  assistantCard.classList.toggle("is-expanded", isExpanded && !isModalOpen);
  assistantCard.classList.toggle("is-modal", isModalOpen);
  document.body.classList.toggle("ai-modal-open", isModalOpen);
  if (modalBackdrop) modalBackdrop.hidden = !isModalOpen;
  if (expandBtn) {
    expandBtn.textContent = isExpanded ? "Normal Size" : "Expand";
    expandBtn.setAttribute("aria-pressed", String(isExpanded));
  }
  if (popoutBtn) {
    popoutBtn.textContent = isModalOpen ? "Close Pop Out" : "Pop Out";
    popoutBtn.setAttribute("aria-pressed", String(isModalOpen));
  }
  requestAnimationFrame(scrollToBottom);
}

function toggleExpanded() {
  isExpanded = !isExpanded;
  syncAssistantLayout();
}

function togglePopout(forceValue) {
  isModalOpen = typeof forceValue === "boolean" ? forceValue : !isModalOpen;
  if (isModalOpen) isExpanded = true;
  syncAssistantLayout();
}

function setThinking(isThinking) {
  if (isThinking) {
    typingIndicator.classList.add("show");
    thinkingOrb?.classList.add("isThinking");
    assistantStateText.textContent = "Analyzing transcripts";
    sendBtn.disabled = true;
    followUpBtn.disabled = true;
  } else {
    typingIndicator.classList.remove("show");
    thinkingOrb?.classList.remove("isThinking");
    assistantStateText.textContent = "Ready";
    sendBtn.disabled = false;
    followUpBtn.disabled = false;
  }
  scrollToBottom();
}

function formatSourceMeta(sources = []) {
  const names = (Array.isArray(sources) ? sources : [])
    .map((source) => String(source?.video_name || source?.video_id || "").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(names)).slice(0, 3);
  return unique.length
    ? `Source basis: ${unique.join(" • ")}`
    : "Minerlytics Education Portal AI Assistant";
}

function addMessage(role, text, meta = "") {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.textContent = text;

  if (meta) {
    const metaDiv = document.createElement("div");
    metaDiv.className = "msgMeta";
    metaDiv.textContent = meta;
    msg.appendChild(metaDiv);
  }

  chatWindow.insertBefore(msg, typingIndicator);
  scrollToBottom();
}

async function askAssistant(question, followUp = false) {
  const cleanQuestion = question.trim();
  if (!cleanQuestion) return;

  lastUserQuestion = cleanQuestion;
  addMessage("user", cleanQuestion, followUp ? "Follow-up question" : "User question");
  history.push({ role: "user", content: cleanQuestion });

  chatInput.value = "";
  setThinking(true);

  try {
    const response = await fetch(API_URL, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    question: cleanQuestion,
    history
  })
});

  const raw = await response.text();

let data = {};
try {
  data = raw ? JSON.parse(raw) : {};
} catch {
  throw new Error(`Server returned non-JSON response: ${raw || "empty response"}`);
}

if (!response.ok) {
  throw new Error(data?.error || `Request failed with status ${response.status}`);
}

    const answer = data?.answer || "I could not find an answer from the transcript library.";
    addMessage("assistant", answer, formatSourceMeta(data?.sources));
    history.push({ role: "assistant", content: answer });
    assistantStateText.textContent = Array.isArray(data?.sources) && data.sources.length ? "Transcript grounded" : "Ready";

  } catch (err) {
    addMessage(
      "assistant",
      `Sorry — the assistant could not respond right now.\n\n${err.message}`,
      "System message"
    );
  } finally {
    setThinking(false);
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await askAssistant(chatInput.value, false);
});

followUpBtn.addEventListener("click", async () => {
  const value = chatInput.value.trim();
  if (!value) {
    chatInput.focus();
    return;
  }
  await askAssistant(value, true);
});

function clearAssistantChat() {
  history = [];
  lastUserQuestion = "";
  const messages = chatWindow.querySelectorAll(".msg");
  messages.forEach((msg, idx) => {
    if (idx > 0) msg.remove();
  });
  typingIndicator.classList.remove("show");
  thinkingOrb?.classList.remove("isThinking");
  assistantStateText.textContent = "Ready";
  chatInput.value = "";
  scrollToBottom();
}

clearBtn.addEventListener("click", clearAssistantChat);
clearBtnTop?.addEventListener("click", clearAssistantChat);
expandBtn?.addEventListener("click", toggleExpanded);
popoutBtn?.addEventListener("click", () => togglePopout());
modalBackdrop?.addEventListener("click", () => togglePopout(false));

chips.forEach((chip) => {
  chip.addEventListener("click", async () => {
    const prompt = chip.dataset.prompt || "";
    chatInput.value = prompt;
    await askAssistant(prompt, false);
  });
});

chatInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    await askAssistant(chatInput.value, false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isModalOpen) {
    togglePopout(false);
  }
});

syncAssistantLayout();
scrollToBottom();
