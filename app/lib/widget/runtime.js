// Storefront runtime. Appended after defaults.js + render.js and served as one script from
// the app proxy (/apps/loyalty/widget.js). Not imported anywhere else.
/* global createWidget normalizeConfig */

(function loyaltyBoot() {
  if (window.__loyaltyBooted) return;
  window.__loyaltyBooted = true;

  var BASE = "/apps/loyalty";
  var TOKEN_KEY = "loyalty_token";
  var REF_KEY = "loyalty_ref";
  var pageMount = document.getElementById("loyalty-page");
  var api = null;
  var lastState = null;

  // localStorage can throw (private mode, blocked storage); the widget must still work.
  function store(op, key, value) {
    try {
      if (op === "get") return window.localStorage.getItem(key);
      if (op === "set") window.localStorage.setItem(key, value);
      if (op === "del") window.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Every call is a POST so the session token travels in the body, never in a URL.
  function post(path, body) {
    var payload = Object.assign({ token: store("get", TOKEN_KEY) || undefined }, body || {});
    return fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(
        function (data) {
          if (!r.ok) throw new Error((data && data.error) || "Request failed");
          return data;
        },
        function () {
          throw new Error("Request failed");
        },
      );
    });
  }

  // Remember a referral link (?ref=CODE) so it can be applied once the shopper is logged in.
  (function captureReferral() {
    try {
      var ref = new URLSearchParams(location.search).get("ref");
      if (ref && /^[A-Za-z0-9]{4,12}$/.test(ref)) store("set", REF_KEY, ref.toUpperCase());
    } catch (e) {
      /* ignore */
    }
  })();

  function requestId() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  }

  function logoutUrl() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    return root + "account/logout";
  }

  function loginUrl() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    return root + "account/login?return_url=" + encodeURIComponent(location.pathname + location.search);
  }

  function field(el, name) {
    var input = el.getRootNode().querySelector('input[data-field="' + name + '"]');
    return input ? input.value.trim() : "";
  }

  function onAction(name, el, widget) {
    var ui = widget.getUi();

    if (name === "login") {
      location.href = loginUrl();
      return;
    }
    if (name === "apply") {
      // Shopify's discount link keeps the code in the visitor's session and sends them to the
      // cart; it is then applied at checkout whatever the payment gateway.
      location.href = "/discount/" + encodeURIComponent(el.dataset.code) + "?redirect=" + encodeURIComponent("/cart");
      return;
    }

    if (name === "otp-send") {
      var email = field(el, "email") || ui.email || "";
      if (!email) {
        widget.setUi({ error: "Enter your email address" });
        return;
      }
      widget.setUi({ busy: true, error: null, email: email });
      post("/otp/request", { email: email })
        .then(function () {
          widget.setUi({ busy: false, step: "code", code: "", error: null, focus: true });
        })
        .catch(function (err) {
          widget.setUi({ busy: false, error: err.message, focus: true });
        });
      return;
    }
    if (name === "otp-back") {
      widget.setUi({ step: "email", error: null, code: "", focus: true });
      return;
    }
    if (name === "otp-verify") {
      var code = field(el, "code");
      if (!/^\d{6}$/.test(code)) {
        widget.setUi({ error: "Enter the 6-digit code" });
        return;
      }
      widget.setUi({ busy: true, error: null, code: code });
      post("/otp/verify", { email: ui.email, code: code })
        .then(function (res) {
          store("set", TOKEN_KEY, res.token);
          widget.setUi({ busy: false, step: "email", email: "", code: "", error: null });
          return refresh();
        })
        .catch(function (err) {
          widget.setUi({ busy: false, error: err.message, focus: true });
        });
      return;
    }

    if (name === "logout") {
      var via = lastState && lastState.via;
      var done = function () {
        store("del", TOKEN_KEY);
        if (via === "shopify") {
          location.href = logoutUrl(); // ends the store-account session too
          return;
        }
        refresh();
      };
      if (via === "shopify") {
        done();
      } else {
        post("/logout").then(done, done); // even if the call fails, forget the token locally
      }
      return;
    }

    if (name === "ref-apply") {
      var rc = field(el, "refcode");
      if (!rc) {
        widget.setUi({ refError: "Enter a code" });
        return;
      }
      applyReferral(widget, rc);
      return;
    }

    if (name === "redeem") {
      el.disabled = true;
      var slider = el.getRootNode().querySelector('input[data-points="' + el.dataset.reward + '"]');
      post("/redeem", {
        rewardId: el.dataset.reward,
        requestId: requestId(),
        points: slider ? Number(slider.value) : undefined,
      })
        .then(function (res) {
          return refresh().then(function () {
            widget.toast(res.code ? "Your code: " + res.code : "Reward redeemed");
          });
        })
        .catch(function (err) {
          el.disabled = false;
          widget.toast(err.message || "Could not redeem");
        });
    }
  }

  function applyReferral(widget, code) {
    return post("/referral", { code: code })
      .then(function () {
        store("del", REF_KEY);
        widget.setUi({ refError: null, refcode: "" });
        return refresh().then(function () {
          widget.toast("Referral code applied");
        });
      })
      .catch(function (err) {
        widget.setUi({ refError: err.message });
        // A code that can't be used (already applied, not a new customer…) shouldn't retry forever.
        store("del", REF_KEY);
      });
  }

  // Apply a code from a referral link automatically, once, when the shopper can use one.
  function autoApplyReferral(state) {
    var ref = store("get", REF_KEY);
    if (!ref || !state.loggedIn) return;
    if (!state.referral || !state.referral.canApply) {
      store("del", REF_KEY);
      return;
    }
    store("del", REF_KEY);
    post("/referral", { code: ref })
      .then(function () {
        return refresh().then(function () {
          if (api) api.toast("Referral code applied");
        });
      })
      .catch(function () {
        /* invalid or already used: nothing to tell the shopper */
      });
  }

  function refresh() {
    return post("/state").then(function (data) {
      lastState = data.state;
      var config = normalizeConfig(data.config);
      if (api) {
        api.update(config, data.state);
        return;
      }
      var isPage = !!pageMount;
      if (!isPage && data.mode !== "WIDGET") return;
      var host = pageMount || document.createElement("div");
      if (!pageMount) {
        host.id = "loyalty-widget-host";
        document.body.appendChild(host);
      }
      api = createWidget(host, config, data.state, {
        mode: isPage ? "page" : "widget",
        onAction: onAction,
      });
      autoApplyReferral(data.state);
    });
  }

  function start() {
    refresh().catch(function (e) {
      if (window.console) console.warn("[loyalty] could not load", e);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
