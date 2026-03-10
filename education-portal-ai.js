const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const followUpBtn = document.getElementById("followUpBtn");
const clearBtn = document.getElementById("clearBtn");
const typingIndicator = document.getElementById("typingIndicator");
const assistantStateText = document.getElementById("assistantStateText");
const chips = Array.from(document.querySelectorAll(".chip"));

let messages = [];

function addMessage(role, text, meta = "") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;

  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "msgMeta";
    metaEl.textContent = meta;
    el.appendChild(metaEl);
  }

  chatWindow.insertBefore(el, typingIndicator);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function setLoading(isLoading) {
  typingIndicator.classList.toggle("show", isLoading);
  sendBtn.disabled = isLoading;
  followUpBtn.disabled = isLoading;
  assistantStateText.textContent = isLoading ? "Thinking" : "Ready";
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendQuestion(question) {
  const trimmed = (question || "").trim();
  if (!trimmed) return;

  addMessage("user", trimmed, "You");
  messages.push({ role: "user", content: trimmed });
  chatInput.value = "";

  setLoading(true);

  try {
    const res = await fetch("/api/education-chat", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ messages })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.details || data?.error || `Request failed with ${res.status}`);
    }

    const answer = data?.answer || "I could not generate an answer.";
    const sourceMeta = data?.sources?.length
      ? `Sources: ${data.sources.map((s) => s.video_name).join(" • ")}`
      : "No matching transcript sources found.";

    addMessage("assistant", answer, sourceMeta);
    messages.push({ role: "assistant", content: answer });
  } catch (err) {
    console.error(err);
    addMessage(
      "assistant",
      "Sorry — I hit an error while querying the Education Portal transcript library.",
      "System"
    );
  } finally {
    setLoading(false);
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await sendQuestion(chatInput.value);
});

followUpBtn.addEventListener("click", async () => {
  const value = chatInput.value.trim();
  if (!value) {
    chatInput.focus();
    return;
  }
  await sendQuestion(value);
});

clearBtn.addEventListener("click", () => {
  messages = [];
  const allMsgs = Array.from(chatWindow.querySelectorAll(".msg"));
  allMsgs.forEach((el, idx) => {
    if (idx > 0) el.remove();
  });
  chatInput.value = "";
  assistantStateText.textContent = "Ready";
});

chips.forEach((chip) => {
  chip.addEventListener("click", async () => {
    const prompt = chip.dataset.prompt || "";
    chatInput.value = prompt;
    await sendQuestion(prompt);
  });
});
