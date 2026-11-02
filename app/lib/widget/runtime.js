// Storefront runtime. Appended after defaults.js + render.js and served as one script from
// the app proxy (/apps/loyalty/widget.js). Not imported anywhere else.
/* global createWidget normalizeConfig */

(function loyaltyBoot() {
  if (window.__loyaltyBooted) return;
  window.__loyaltyBooted = true;

  var BASE = "/apps/loyalty";
  var TOKEN_KEY = "loyalty_token";
  var REF_KEY = "loyalty_ref";
  var CART_FLAG = "loyalty_cart_ref";
  var pageMount = document.getElementById("loyalty-page");
  var api = null; //        floating widget / inline page
  var drawerApi = null; //  side drawer ("My Rewards")
  var lastState = null;
  var lastConfig = null;
  var booted = false;

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

  function root() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  }
  function logoutUrl() {
    return root() + "account/logout";
  }
  function loginUrl() {
    return root() + "account/login?return_url=" + encodeURIComponent(location.pathname + location.search);
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
          var w = drawerApi || api;
          if (w) w.toast("Referral code applied");
        });
      })
      .catch(function () {
        /* invalid or already used: nothing to tell the shopper */
      });
  }

  // --- checkout: tell Shopify which loyalty account is open ----------------------------------
  // Guest checkouts credit the account open in the widget. The cart carries a signed reference
  // (only the server can make a valid one); signed-in shoppers earn on their own account anyway.
  function syncCartRef(state) {
    var want = (state && state.checkoutRef) || "";
    if (!want && store("get", CART_FLAG) !== "1") return; // nothing to set, nothing to clear
    fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cart) {
        if (!cart) return;
        var have = (cart.attributes && cart.attributes.loyalty_ref) || "";
        if (have === want) return;
        return fetch("/cart/update.js", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ attributes: { loyalty_ref: want } }),
        }).then(function (r) {
          if (r.ok) store(want ? "set" : "del", CART_FLAG, "1");
        });
      })
      .catch(function () {
        /* the cart is not essential */
      });
  }

  // --- the side drawer ("My Rewards") -----------------------------------------------------------
  function openDrawer() {
    if (!lastConfig) {
      refresh().then(openDrawer);
      return;
    }
    if (!drawerApi) {
      var host = document.createElement("div");
      host.id = "loyalty-drawer-host";
      document.body.appendChild(host);
      drawerApi = createWidget(host, lastConfig, lastState, {
        mode: "drawer",
        startOpen: true,
        onAction: onAction,
        onToggle: function (isOpen) {
          if (!isOpen && location.hash === "#loyalty") history.replaceState(null, "", location.pathname + location.search);
        },
      });
    } else {
      drawerApi.setOpen(true);
    }
  }

  // Anything marked data-loyalty-open (or linking to #loyalty) opens the drawer — handy for a
  // menu item in the theme's own navigation.
  document.addEventListener(
    "click",
    function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-loyalty-open], a[href="#loyalty"], a[href="#my-rewards"]') : null;
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      openDrawer();
    },
    true,
  );
  function openFromHash() {
    if (location.hash === "#loyalty" || location.hash === "#my-rewards") openDrawer();
  }
  window.addEventListener("hashchange", openFromHash);

  // --- the "My Rewards" tab on the customer account page ------------------------------------------
  // Themes build their account menu in many ways, so this copies an existing menu entry (the one
  // just above "Log out"), changes its label/icon, and points it at the drawer. If the theme's
  // markup can't be matched, a small button appears instead, and merchants can always add their
  // own link with data-loyalty-open.
  function menuItemOf(link) {
    var node = link;
    while (node.parentElement && node.parentElement !== document.body) {
      if (node.parentElement.children.length >= 3) return node;
      node = node.parentElement;
    }
    return null;
  }

  function buildTab(template, acct) {
    var el = template.cloneNode(true);
    var all = [el].concat([].slice.call(el.querySelectorAll("*")));
    all.forEach(function (n) {
      n.removeAttribute("id");
      if (n.className && typeof n.className === "string") {
        n.className = n.className
          .split(/\s+/)
          .filter(function (c) {
            return c && !/active|current|selected|is-open/i.test(c);
          })
          .join(" ");
      }
    });
    var a = el.matches && el.matches("a") ? el : el.querySelector("a") || el;
    a.setAttribute("href", "#loyalty");
    a.setAttribute("data-loyalty-open", "");
    a.setAttribute("data-loyalty-tab", "1");
    a.removeAttribute("target");
    a.removeAttribute("aria-current");

    // label: first real text becomes ours; other text and number badges go
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var texts = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) texts.push(walker.currentNode);
    var label = texts.filter(function (n) {
      return !/^\d+$/.test(n.nodeValue.trim());
    });
    if (label.length) {
      label[0].nodeValue = acct.label;
      label.slice(1).forEach(function (n) {
        n.nodeValue = "";
      });
    } else {
      a.appendChild(document.createTextNode(acct.label));
    }
    [].slice.call(el.querySelectorAll("*")).forEach(function (n) {
      if (!n.children.length && /^\s*\d+\s*$/.test(n.textContent)) n.remove();
    });

    // icon: swap the copied one for ours
    var icon = el.querySelector("svg, img");
    if (icon) {
      var span = document.createElement("span");
      span.textContent = acct.icon;
      span.setAttribute("aria-hidden", "true");
      span.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:1.25em;font-size:1.1em;line-height:1";
      icon.parentNode.replaceChild(span, icon);
    }
    return el;
  }

  function injectTab(acct) {
    if (document.querySelector("[data-loyalty-tab]")) return true;
    var container = null;
    var before = null;
    var template = null;
    if (acct.selector) {
      var c = document.querySelector(acct.selector);
      if (c && c.lastElementChild) {
        container = c;
        before = c.lastElementChild;
        template = c.lastElementChild.previousElementSibling || c.lastElementChild;
      }
    } else {
      var links = document.querySelectorAll('a[href*="/account/logout"]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].closest("header, footer, [role=dialog]")) continue;
        var item = menuItemOf(links[i]);
        if (!item) continue;
        container = item.parentElement;
        before = item;
        template = item.previousElementSibling || item;
        break;
      }
    }
    if (!container) return false;
    container.insertBefore(buildTab(template, acct), before);
    return true;
  }

  function fallbackButton(acct) {
    if (document.querySelector("[data-loyalty-tab]") || api) return; // there is already a way in
    var theme = (lastConfig && lastConfig.theme) || {};
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-loyalty-open", "");
    b.setAttribute("data-loyalty-tab", "1");
    b.textContent = acct.icon + "  " + acct.label;
    b.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147482000;border:0;cursor:pointer;padding:12px 18px;border-radius:999px;font:600 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.22);" +
      "background:" + (theme.primary || "#111827") + ";color:" + (theme.primaryText || "#fff");
    document.body.appendChild(b);
  }

  function setupAccountTab(cfg) {
    var acct = cfg.account || {};
    if (acct.tab === false) return;
    if (!/(^|\/)account(\/|$)/.test(location.pathname)) return;
    var attempts = 0;
    if (injectTab(acct)) return;
    var mo = new MutationObserver(function () {
      attempts += 1;
      if (injectTab(acct) || attempts > 120) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () {
      mo.disconnect();
      fallbackButton(acct);
    }, 4000);
  }

  // --- data ------------------------------------------------------------------------------------------
  function refresh() {
    return post("/state").then(function (data) {
      lastState = data.state;
      lastConfig = normalizeConfig(data.config);
      if (api) api.update(lastConfig, data.state);
      if (drawerApi) drawerApi.update(lastConfig, data.state);

      if (!api) {
        var isPage = !!pageMount;
        if (isPage || data.mode === "WIDGET") {
          var host = pageMount || document.createElement("div");
          if (!pageMount) {
            host.id = "loyalty-widget-host";
            document.body.appendChild(host);
          }
          api = createWidget(host, lastConfig, data.state, { mode: isPage ? "page" : "widget", onAction: onAction });
        }
      }
      if (!booted) {
        booted = true;
        setupAccountTab(lastConfig);
        autoApplyReferral(data.state);
        openFromHash();
      }
      syncCartRef(data.state);
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
