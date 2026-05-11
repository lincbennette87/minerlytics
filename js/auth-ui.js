(function () {
  const API_BASE = "https://minerlytics-dev.lincbennette87.workers.dev";

  function esc(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setUserCache(user) {
    if (!user) return;
    localStorage.setItem("minerlytics_user_email", user.email || "");
    localStorage.setItem("minerlytics_user_name", user.display_name || "");
    localStorage.setItem("minerlytics_user_first_name", user.first_name || "");
    localStorage.setItem("minerlytics_user_last_name", user.last_name || "");
  }

  function clearUserCache() {
    localStorage.removeItem("minerlytics_user_email");
    localStorage.removeItem("minerlytics_user_name");
    localStorage.removeItem("minerlytics_user_first_name");
    localStorage.removeItem("minerlytics_user_last_name");
  }

  function renderLoggedOut(authNav) {
    authNav.innerHTML = `
      <a class="btn btnGhost" href="./login.html">Sign In</a>
      <a class="btn btnPrimary" href="./signup.html">Join Minerlytics</a>
    `;
  }

  function renderLoggedIn(authNav, user) {
    const displayName = user.display_name || user.email || "Minerlytics User";
    authNav.innerHTML = `
      <div style="position:relative;">
        <button id="accountBtn" class="btn btnGhost" type="button">
          👤 ${esc(displayName)}
        </button>

        <div id="accountMenu" style="
          display:none;
          position:absolute;
          right:0;
          top:44px;
          background:rgba(11,19,42,.96);
          border:1px solid rgba(255,255,255,.14);
          border-radius:14px;
          padding:12px;
          min-width:240px;
          z-index:999;
          box-shadow:0 20px 60px rgba(0,0,0,.45);
        ">
          <div style="font-size:12px;color:rgba(234,240,255,.65);margin-bottom:6px;">
            Signed in as
          </div>

          <div style="font-size:13px;color:#eaf0ff;margin-bottom:4px;word-break:break-word;">
            ${esc(displayName)}
          </div>

          <div style="font-size:12px;color:rgba(234,240,255,.62);margin-bottom:12px;word-break:break-all;">
            ${esc(user.email || "")}
          </div>

          <a class="btn btnGhost" href="./change-password.html" style="width:100%;display:flex;justify-content:center;text-decoration:none;margin-bottom:8px;">
            Change Password
          </a>

          <button class="btn btnGhost" id="logoutBtn" type="button" style="width:100%;">
            Logout
          </button>
        </div>
      </div>
    `;

    const btn = document.getElementById("accountBtn");
    const menu = document.getElementById("accountMenu");
    const logoutBtn = document.getElementById("logoutBtn");

    if (btn && menu) {
      btn.onclick = function (event) {
        event.stopPropagation();
        menu.style.display = menu.style.display === "block" ? "none" : "block";
      };

      document.addEventListener("click", function () {
        menu.style.display = "none";
      });
    }

    if (logoutBtn) {
      logoutBtn.onclick = async function () {
        await fetch(API_BASE + "/api/logout", {
          method: "POST",
          credentials: "include"
        });
        clearUserCache();
        window.location.reload();
      };
    }
  }

  async function init() {
    const authNav = document.getElementById("authNav");
    if (!authNav) return;

    try {
      const res = await fetch(API_BASE + "/api/me", {
        credentials: "include"
      });
      const data = await res.json();

      if (!data.loggedIn || !data.user) {
        clearUserCache();
        renderLoggedOut(authNav);
        return;
      }

      setUserCache(data.user);
      renderLoggedIn(authNav, data.user);
    } catch (err) {
      console.error("AUTH NAV ERROR:", err);
      renderLoggedOut(authNav);
    }
  }

  window.MinerlyticsAuthUI = {
    init,
    setUserCache,
    clearUserCache
  };

  init();
})();
