// Container dynamic challenge view script
CTFd._internal.challenge.data = undefined;
CTFd._internal.challenge.preRender = function () {};
CTFd._internal.challenge.render = null;

// postRender must be set at top level (outside the guard) so it is
// re-assigned every time this script is loaded for a new challenge.
CTFd._internal.challenge.postRender = function () {
  if (window.__k8sCheckExistingInstance) window.__k8sCheckExistingInstance();
};

CTFd._internal.challenge.submit = function (preview) {
  var $ = CTFd.lib.$;
  var challenge_id = parseInt($("#challenge-id").val(), 10);
  var submission = $("#challenge-input").val();

  var body = {
    challenge_id: challenge_id,
    submission: submission
  };
  var params = {};
  if (preview) {
    params["preview"] = true;
  }

  return CTFd.api.post_challenge_attempt(params, body).then(function(response) {
    if (response.status === 429) {
      return response;
    }
    if (response.status === 403) {
      return response;
    }
    return response;
  });
};

// Define container control functions globally (once)
(function () {
  if (window.__k8sContainerFunctionsInitialized) return;
  window.__k8sContainerFunctionsInitialized = true;

  var _timerInterval = null;

  function getRoot(el) {
    return el.closest("#container-challenge-ctl") || document;
  }

  function getChallengeId() {
    var input = document.getElementById("challenge-id");
    return input ? input.value : null;
  }

  function setState(root, state) {
    var idle = root.querySelector("#container-idle");
    var loading = root.querySelector("#container-loading");
    var active = root.querySelector("#container-active");
    if (!idle || !loading || !active) return;
    idle.style.display = "none";
    loading.style.display = "none";
    active.style.display = "none";
    if (state === "idle") idle.style.display = "";
    else if (state === "loading") loading.style.display = "";
    else if (state === "active") active.style.display = "";
  }

  function clearTimer() {
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
  }

  function applyActive(root, data) {
    var webInfo = root.querySelector("#container-web-info");
    var tcpInfo = root.querySelector("#container-tcp-info");
    var connEl = root.querySelector("#container-connection");
    var tcpHostEl = root.querySelector("#container-tcp-host");
    var tcpPortEl = root.querySelector("#container-tcp-port");
    var timerEl = root.querySelector("#container-timer");
    var info = (data && data.connection_info) || "";

    if (/^https?:\/\//i.test(info)) {
      // Web challenge — show clickable URL
      if (connEl) {
        connEl.href = info;
        connEl.textContent = info;
      }
      if (webInfo) webInfo.style.display = "";
      if (tcpInfo) tcpInfo.style.display = "none";
    } else {
      // TCP challenge — parse "nc host port" into separate fields
      var host = "";
      var port = "";
      var ncMatch = info.match(/^nc\s+(\S+)\s+(\d+)/);
      if (ncMatch) {
        host = ncMatch[1];
        port = ncMatch[2];
      } else if (info) {
        host = info;
      }
      if (tcpHostEl) tcpHostEl.textContent = host || "n/a";
      if (tcpPortEl) tcpPortEl.textContent = port || "n/a";
      if (tcpInfo) tcpInfo.style.display = "";
      if (webInfo) webInfo.style.display = "none";
    }

    // Clear any existing timer before setting a new one
    clearTimer();

    if (timerEl && data && data.expires_at) {
      var exp = parseInt(data.expires_at, 10) || 0;
      var fmt = function (sec) {
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        function pad(x) { return x < 10 ? "0" + x : "" + x; }
        return pad(h) + ":" + pad(m) + ":" + pad(s);
      };
      var tick = function () {
        var left = exp - Math.floor(Date.now() / 1000);
        if (left <= 0) {
          clearTimer();
          timerEl.textContent = "00:00:00";
          setState(root, "idle");
          return;
        }
        timerEl.textContent = fmt(left);
      };
      tick();
      _timerInterval = setInterval(tick, 1000);
    }
    setState(root, "active");
  }

  var urlRoot = (window.CTFd && CTFd.config && CTFd.config.urlRoot) || "";
  var fetchFn = (window.CTFd && CTFd.fetch) || window.fetch.bind(window);

  // Track last checked challenge ID to avoid redundant calls
  var _lastCheckedCid = null;

  // Check for an existing running instance and restore the active UI.
  // Exposed on window so postRender (set outside the guard) can call it.
  window.__k8sCheckExistingInstance = function () {
    clearTimer();
    var root = document.getElementById("container-challenge-ctl");
    if (!root) return;
    var cid = getChallengeId();
    if (!cid) return;

    _lastCheckedCid = cid;

    fetchFn(urlRoot + "/api/v1/container/status?challenge_id=" + encodeURIComponent(cid), {
      method: "GET",
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success && r.data) {
          var st = r.data.status;
          if (st === "Running" || st === "Pending") {
            // Re-fetch root in case DOM changed
            var currentRoot = document.getElementById("container-challenge-ctl");
            if (currentRoot) applyActive(currentRoot, r.data);
          }
        }
      })
      .catch(function () {
        // Silently fail — leave in idle state
      });
  };

  // MutationObserver: reliably detect when the container control div appears
  // in the DOM (e.g. when a challenge modal is opened). This is more reliable
  // than postRender alone, which may not fire if CTFd caches the script.
  var _ctlObserver = new MutationObserver(function () {
    var ctl = document.getElementById("container-challenge-ctl");
    if (!ctl) return;
    var cid = getChallengeId();
    if (!cid) return;
    // Only trigger if this is a new challenge (avoid duplicate checks)
    if (cid !== _lastCheckedCid) {
      window.__k8sCheckExistingInstance();
    }
  });
  _ctlObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.k8sStartContainer = function (btn) {
    var root = getRoot(btn);
    var cid = getChallengeId();
    if (!cid) {
      alert("Unable to determine challenge ID");
      return;
    }
    setState(root, "loading");
    fetchFn(urlRoot + "/api/v1/container/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: cid })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success && r.data) {
          applyActive(root, r.data);
        } else {
          alert((r && r.error) || "Failed to start instance");
          setState(root, "idle");
        }
      })
      .catch(function (err) {
        alert("Failed to start instance: " + err.message);
        setState(root, "idle");
      });
  };

  window.k8sStopContainer = function (btn) {
    var root = getRoot(btn);
    var cid = getChallengeId();
    if (!cid) {
      alert("Unable to determine challenge ID");
      return;
    }
    fetchFn(urlRoot + "/api/v1/container/stop", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: cid })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success) {
          clearTimer();
          setState(root, "idle");
        } else if (r && r.error) {
          alert(r.error);
        }
      })
      .catch(function (err) {
        alert("Failed to stop: " + err.message);
      });
  };

  window.k8sRenewContainer = function (btn) {
    var root = getRoot(btn);
    var cid = getChallengeId();
    if (!cid) {
      alert("Unable to determine challenge ID");
      return;
    }
    fetchFn(urlRoot + "/api/v1/container/renew", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: cid, restart: true })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.success && r.data) {
          applyActive(root, r.data);
        } else if (r && r.error) {
          alert(r.error);
        }
      })
      .catch(function (err) {
        alert("Failed to reset: " + err.message);
      });
  };
})();
