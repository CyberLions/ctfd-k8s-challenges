// Injects container instance status badges into challenge cards on the listing page.
// Also handles toast notifications for team-wide lifecycle events and expiration warnings.
// Loaded globally via register_plugin_script; only activates when challenge cards exist.
(function () {
  var _statusData = {};
  var _prevStatusData = {};
  var _tickInterval = null;
  var _pollInterval = null;
  var _started = false;

  var urlRoot = (window.CTFd && CTFd.config && CTFd.config.urlRoot) || "";

  function fetchFn(url, opts) {
    var fn = (window.CTFd && CTFd.fetch) || window.fetch.bind(window);
    return fn(url, opts);
  }

  function fmtShort(sec) {
    if (sec <= 0) return "Expired";
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function pad(x) { return x < 10 ? "0" + x : "" + x; }
    if (h > 0) return pad(h) + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  // -------------------------------------------------------------------------
  // Toast notification system (Bootstrap 5 styled)
  // -------------------------------------------------------------------------
  var _toastContainer = null;

  function getToastContainer() {
    if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
    _toastContainer = document.createElement("div");
    _toastContainer.className = "toast-container position-fixed bottom-0 end-0 p-3";
    _toastContainer.style.zIndex = "1090";
    document.body.appendChild(_toastContainer);
    return _toastContainer;
  }

  function showToast(message, type) {
    var container = getToastContainer();

    var headerColors = {
      warning: "bg-warning text-dark",
      danger:  "bg-danger text-white",
      success: "bg-success text-white",
      info:    "bg-secondary text-white"
    };
    var headerClass = headerColors[type] || headerColors.info;

    var titles = {
      warning: "Warning",
      danger:  "Alert",
      success: "Success",
      info:    "Info"
    };
    var title = titles[type] || "Info";

    var toast = document.createElement("div");
    toast.className = "toast show";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    toast.setAttribute("aria-atomic", "true");
    toast.innerHTML =
      '<div class="toast-header ' + headerClass + '">' +
      '  <strong class="me-auto">' + title + '</strong>' +
      '  <small>just now</small>' +
      '  <button type="button" class="btn-close btn-close-white ms-2" aria-label="Close"></button>' +
      '</div>' +
      '<div class="toast-body">' + message + '</div>';

    // Close button handler
    var closeBtn = toast.querySelector(".btn-close");
    closeBtn.addEventListener("click", function () {
      dismissToast(toast);
    });

    // For dark header text (warning), use dark close button
    if (type === "warning") {
      closeBtn.classList.remove("btn-close-white");
    }

    container.appendChild(toast);

    // Auto-dismiss after 6 seconds
    setTimeout(function () {
      dismissToast(toast);
    }, 6000);
  }

  function dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.remove("show");
    toast.classList.add("hide");
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  // -------------------------------------------------------------------------
  // Expiration warnings
  // -------------------------------------------------------------------------
  // Track which warnings have been shown: { "cid": { 600: true, 300: true, 60: true } }
  var _expirationWarningsShown = {};
  var WARNING_THRESHOLDS = [600, 300, 60]; // 10min, 5min, 1min
  var _initialSeedDone = false;

  // On first status fetch, mark all already-passed thresholds as "shown"
  // so they don't fire on page load. Only newly crossed thresholds trigger toasts.
  function seedExpirationWarnings() {
    var now = Math.floor(Date.now() / 1000);
    for (var cid in _statusData) {
      var instance = _statusData[cid];
      if (!instance || !instance.expires_at) continue;
      var left = instance.expires_at - now;
      if (left <= 0) continue;

      if (!_expirationWarningsShown[cid]) _expirationWarningsShown[cid] = {};

      for (var i = 0; i < WARNING_THRESHOLDS.length; i++) {
        var threshold = WARNING_THRESHOLDS[i];
        if (left <= threshold) {
          _expirationWarningsShown[cid][threshold] = true;
        }
      }
    }
    _initialSeedDone = true;
  }

  function checkExpirationWarnings() {
    if (!_initialSeedDone) return;

    var now = Math.floor(Date.now() / 1000);
    // Clean up warnings for instances that no longer exist
    for (var oldCid in _expirationWarningsShown) {
      if (!_statusData[oldCid]) {
        delete _expirationWarningsShown[oldCid];
      }
    }
    for (var cid in _statusData) {
      var instance = _statusData[cid];
      if (!instance || !instance.expires_at) continue;
      var left = instance.expires_at - now;
      if (left <= 0) continue;

      if (!_expirationWarningsShown[cid]) _expirationWarningsShown[cid] = {};

      for (var i = 0; i < WARNING_THRESHOLDS.length; i++) {
        var threshold = WARNING_THRESHOLDS[i];
        if (left <= threshold && !_expirationWarningsShown[cid][threshold]) {
          _expirationWarningsShown[cid][threshold] = true;
          var challengeName = getChallengeNameByCid(cid);
          var minutes = Math.floor(threshold / 60);
          var label = minutes > 1 ? minutes + " minutes" : "1 minute";
          showToast(challengeName + " expires in " + label, "warning");
        }
      }
    }
  }

  function getChallengeNameByCid(cid) {
    // Try to get the challenge name from the button text on the page
    var buttons = document.querySelectorAll(".challenge-button");
    for (var i = 0; i < buttons.length; i++) {
      if (String(buttons[i].value) === String(cid)) {
        var nameEl = buttons[i].querySelector(".challenge-name, .text-truncate");
        if (nameEl) return nameEl.textContent.trim();
        // Fallback: try the inner text but avoid badges
        var inner = buttons[i].querySelector(".challenge-inner");
        if (inner) {
          var firstChild = inner.querySelector("span, div, p");
          if (firstChild) return firstChild.textContent.trim();
        }
        return "Challenge #" + cid;
      }
    }
    return "Challenge #" + cid;
  }

  // -------------------------------------------------------------------------
  // Expiration detection (instance vanished and was recently expired)
  // -------------------------------------------------------------------------
  function checkExpirations() {
    var now = Math.floor(Date.now() / 1000);
    for (var cid in _prevStatusData) {
      if (!_statusData[cid] && _prevStatusData[cid]) {
        var prev = _prevStatusData[cid];
        // If expires_at was within the last 2 minutes, treat it as expired
        if (prev.expires_at && (now - prev.expires_at) < 120 && (now - prev.expires_at) >= 0) {
          var challengeName = getChallengeNameByCid(cid);
          showToast(challengeName + " has expired", "danger");
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event polling
  // -------------------------------------------------------------------------
  var _lastEventTimestamp = 0;
  var _eventsInitialized = false;

  function fetchEvents() {
    if (!_eventsInitialized) {
      // On first poll, set timestamp to now to skip stale events
      _lastEventTimestamp = Date.now() / 1000;
      _eventsInitialized = true;
    }
    fetchFn(urlRoot + "/api/v1/container/events?since=" + _lastEventTimestamp, {
      method: "GET",
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.success || !r.events) return;
        var events = r.events;
        var selfEvents = window.__k8sSelfEvents || {};
        for (var i = 0; i < events.length; i++) {
          var evt = events[i];
          _lastEventTimestamp = Math.max(_lastEventTimestamp, evt.timestamp);
          // Check self-event suppression
          var selfKey = evt.event_type + "-" + evt.challenge_id;
          if (selfEvents[selfKey]) {
            delete selfEvents[selfKey];
            continue;
          }
          var name = evt.challenge_name || ("Challenge #" + evt.challenge_id);
          var user = evt.user_name || "Someone";
          var msg = "";
          var toastType = "info";
          if (evt.event_type === "start") {
            msg = user + " started " + name;
            toastType = "success";
          } else if (evt.event_type === "stop") {
            msg = user + " stopped " + name;
            toastType = "danger";
          } else if (evt.event_type === "reset") {
            msg = user + " reset " + name;
            toastType = "info";
          } else if (evt.event_type === "expired") {
            msg = name + " has expired";
            toastType = "danger";
          }
          if (msg) showToast(msg, toastType);
        }
      })
      .catch(function () {});
  }

  // -------------------------------------------------------------------------
  // Badge rendering
  // -------------------------------------------------------------------------
  function updateBadges() {
    var now = Math.floor(Date.now() / 1000);
    var buttons = document.querySelectorAll(".challenge-button");

    buttons.forEach(function (btn) {
      var cid = btn.value;
      if (!cid) return;
      var instance = _statusData[String(cid)];
      var badge = btn.querySelector(".k8s-status-badge");

      if (!instance || !instance.expires_at) {
        if (badge) badge.remove();
        return;
      }

      var left = instance.expires_at - now;
      if (left <= 0) {
        if (badge) badge.remove();
        delete _statusData[String(cid)];
        return;
      }

      if (!badge) {
        badge = document.createElement("div");
        badge.className = "k8s-status-badge";
        badge.style.cssText = "margin-top:6px;font-size:0.72rem;opacity:0.85;";
        var inner = btn.querySelector(".challenge-inner");
        if (inner) inner.appendChild(badge);
      }

      var color = instance.status === "Running" ? "#28a745" : "#ffc107";
      var label = instance.status === "Running" ? "Running" : "Starting";
      badge.innerHTML =
        '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' +
        color + ';margin-right:4px;vertical-align:middle;"></span>' +
        label + " \u00B7 " + fmtShort(left);
    });

    // Check expiration warnings on every tick
    checkExpirationWarnings();
  }

  function fetchStatuses() {
    fetchFn(urlRoot + "/api/v1/container/status/all", {
      method: "GET",
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success && r.data) {
          _prevStatusData = _statusData;
          _statusData = r.data;
          // On first successful fetch, seed warnings so we don't
          // spam toasts for thresholds already passed before page load
          if (!_initialSeedDone) seedExpirationWarnings();
          checkExpirations();
        }
        updateBadges();
      })
      .catch(function () {});
  }

  function tryStart() {
    if (_started) return;
    var buttons = document.querySelectorAll(".challenge-button");
    if (buttons.length === 0) return;

    _started = true;
    fetchStatuses();
    fetchEvents();
    _pollInterval = setInterval(function () {
      fetchStatuses();
      fetchEvents();
    }, 30000);
    _tickInterval = setInterval(updateBadges, 1000);
  }

  // Observe DOM for challenge cards appearing (Alpine renders asynchronously)
  var observer = new MutationObserver(function () {
    if (!_started) tryStart();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Also try immediately and on DOMContentLoaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryStart);
  } else {
    tryStart();
  }

  // Re-fetch when challenges are reloaded (e.g. after a solve)
  window.addEventListener("load-challenges", function () {
    fetchStatuses();
    fetchEvents();
  });
})();
