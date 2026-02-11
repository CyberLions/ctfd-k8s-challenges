// Container challenge view script
CTFd._internal.challenge.data = undefined;
CTFd._internal.challenge.preRender = function () {};
CTFd._internal.challenge.render = null;
CTFd._internal.challenge.postRender = function () {};

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

// Define container control functions globally
(function () {
  if (window.__k8sContainerFunctionsInitialized) return;
  window.__k8sContainerFunctionsInitialized = true;

  function getRoot(el) {
    return el.closest("#container-challenge-ctl") || document;
  }

  function getChallengeId(el) {
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

  function applyActive(root, data) {
    var connEl = root.querySelector("#container-connection");
    var ncEl = root.querySelector("#container-nc");
    var timerEl = root.querySelector("#container-timer");
    var info = (data && data.connection_info) || "";
    if (/^https?:\/\//i.test(info)) {
      if (connEl) {
        connEl.href = info;
        connEl.textContent = info;
        connEl.style.display = "";
      }
      if (ncEl) ncEl.style.display = "none";
    } else {
      if (connEl) connEl.style.display = "none";
      if (ncEl) {
        ncEl.textContent = info || "n/a";
        ncEl.style.display = "";
      }
    }
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
          timerEl.textContent = "00:00:00";
          return;
        }
        timerEl.textContent = fmt(left);
      };
      tick();
      setInterval(tick, 1000);
    }
    setState(root, "active");
  }

  var urlRoot = (window.CTFd && CTFd.config && CTFd.config.urlRoot) || "";
  var fetchFn = (window.CTFd && CTFd.fetch) || window.fetch.bind(window);

  window.k8sStartContainer = function (btn) {
    var root = getRoot(btn);
    var cid = getChallengeId(btn);
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
    var cid = getChallengeId(btn);
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
    var cid = getChallengeId(btn);
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
