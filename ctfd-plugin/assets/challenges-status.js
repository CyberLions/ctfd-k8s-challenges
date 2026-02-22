// Injects container instance status badges into challenge cards on the listing page.
// Loaded globally via register_plugin_script; only activates when challenge cards exist.
(function () {
  var _statusData = {};
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
  }

  function fetchStatuses() {
    fetchFn(urlRoot + "/api/v1/container/status/all", {
      method: "GET",
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success && r.data) {
          _statusData = r.data;
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
    _pollInterval = setInterval(fetchStatuses, 30000);
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
  window.addEventListener("load-challenges", fetchStatuses);
})();
