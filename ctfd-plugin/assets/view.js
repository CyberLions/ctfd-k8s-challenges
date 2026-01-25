var $ = CTFd.lib.$;

var STORAGE_KEY = "ctfd_k8s_container";

function storageGet(cid) {
  try {
    var raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw)[String(cid)] : null;
  } catch (e) { return null; }
}

function storageSet(cid, data) {
  try {
    var all = {};
    var raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) try { all = JSON.parse(raw); } catch (e) {}
    all[String(cid)] = data;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (e) {}
}

function storageDel(cid) {
  try {
    var raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    var all = JSON.parse(raw);
    delete all[String(cid)];
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (e) {}
}

function show(id) { $(id).closest(".form-group").show(); }
function hide(id) { $(id).closest(".form-group").hide(); }

function formatTime(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

CTFd._internal.challenge.data = undefined;
CTFd._internal.challenge.preRender = function () {};
CTFd._internal.challenge.render = null;
CTFd._internal.challenge.postRender = function () {
  var cid = $("#challenge-id").val();
  var $ctl = $("#container-challenge-ctl");
  if (!$ctl.length || !cid) return;

  var urlRoot = (typeof CTFd !== "undefined" && CTFd.config && CTFd.config.urlRoot) ? CTFd.config.urlRoot : (window.scriptRoot || "");
  var idle = $("#container-idle"), loading = $("#container-loading"), active = $("#container-active");
  var conn = $("#container-connection"), nc = $("#container-nc"), timerEl = $("#container-timer");
  var timer = null;

  function setState(s) {
    idle.hide(); loading.hide(); active.hide();
    if (s === "idle") idle.show();
    else if (s === "loading") loading.show();
    else active.show();
  }

  function applyActive(data) {
    var info = (data && data.connection_info) || "";
    if (/^https?:\/\//i.test(info)) {
      conn.attr("href", info).text(info).show();
      nc.hide();
    } else {
      conn.hide();
      nc.text(info || "n/a").show();
    }
    var exp = (data && data.expires_at) ? parseInt(data.expires_at, 10) : 0;
    function tick() {
      var left = exp - Math.floor(Date.now() / 1000);
      if (left <= 0) { clearInterval(timer); storageDel(cid); setState("idle"); return; }
      timerEl.text(formatTime(left));
    }
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, 1000);
    setState("active");
  }

  // Restore from sessionStorage or status
  (function init() {
    var stored = storageGet(cid);
    if (stored && (stored.connection_info || stored.expires_at)) {
      var exp = parseInt(stored.expires_at, 10) || 0;
      if (exp > Math.floor(Date.now() / 1000)) {
        applyActive(stored);
        return;
      }
      storageDel(cid);
    }
    $.get(urlRoot + "/api/v1/container/status", { challenge_id: cid })
      .then(function (r) {
        if (r.success && r.data && r.data.status === "Running" && stored) applyActive(stored);
        else setState("idle");
      })
      .fail(function () { setState("idle"); });
  })();

  $("#container-start-btn").on("click", function () {
    setState("loading");
    $.ajax({
      url: urlRoot + "/api/v1/container/start",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({ challenge_id: cid }),
    })
      .done(function (r) {
        if (r.success && r.data) {
          storageSet(cid, { connection_info: r.data.connection_info, expires_at: r.data.expires_at });
          applyActive(r.data);
        } else {
          alert(r.error || "Failed to start");
          setState("idle");
        }
      })
      .fail(function (xhr) {
        var err = (xhr.responseJSON && xhr.responseJSON.error) || xhr.statusText || "Request failed";
        alert(err);
        setState("idle");
      });
  });

  $("#container-stop-btn").on("click", function () {
    $.ajax({
      url: root + "/api/v1/container/stop",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({ challenge_id: cid }),
    })
      .done(function (r) {
        if (r.success) { if (timer) clearInterval(timer); storageDel(cid); setState("idle"); }
      });
  });

  $("#container-renew-btn").on("click", function () {
    $.ajax({
      url: urlRoot + "/api/v1/container/renew",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({ challenge_id: cid, restart: true }),
    })
      .done(function (r) {
        if (r.success && r.data && r.data.expires_at) {
          var d = storageGet(cid) || {};
          d.expires_at = r.data.expires_at;
          storageSet(cid, d);
          applyActive(d);
        }
      });
  });
};

CTFd._internal.challenge.submit = function (preview) {
  var challenge_id = parseInt($("#challenge-id").val(), 10);
  var submission = $("#challenge-input").val();
  var body = { challenge_id: challenge_id, submission: submission };
  var params = {};
  if (preview) params["preview"] = true;
  return CTFd.api.post_challenge_attempt(params, body);
};
