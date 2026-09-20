import { createLicenKitCheckout, LicenKitCheckoutError } from "@licenkit/checkout";
import { readCheckoutConfig } from "./checkout-config.js";

const title = document.querySelector("[data-product-title]");
const description = document.querySelector("[data-product-description]");
const status = document.querySelector("[data-checkout-status]");
const offers = document.querySelector("[data-offers]");

if (!(title instanceof HTMLElement) || !(description instanceof HTMLElement)
  || !(status instanceof HTMLElement) || !(offers instanceof HTMLElement)) {
  throw new Error("Checkout page elements are missing.");
}

function safeCheckoutMessage(error) {
  if (!(error instanceof LicenKitCheckoutError)) return "Checkout is temporarily unavailable.";
  switch (error.code) {
    case "CHECKOUT_NOT_AVAILABLE": return "Purchasing is temporarily unavailable. Please try again later.";
    case "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE": return "Checkout is not enabled for this website yet.";
    case "CHECKOUT_OFFER_NOT_FOUND": return "This offer is no longer available. Refresh the page to see current offers.";
    default: return "Checkout could not be loaded. Please try again later.";
  }
}

function element(tagName, text, className) {
  const node = document.createElement(tagName);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

let checkout;
async function startCheckout() {
  try {
    checkout = createLicenKitCheckout({
      ...readCheckoutConfig(),
      onEvent(event) {
        if (event.type === "checkout.completed") {
          status.textContent = "Payment submitted. Your license will be sent by email after server verification.";
        } else if (event.type === "checkout.error") {
          status.textContent = "The payment window reported an error. Please try again.";
        }
      },
    });

    const state = await checkout.load();
    title.textContent = state.product.name;
    description.textContent = state.product.description ?? "Choose a license offer.";
    if (!state.available) {
      status.textContent = "Purchasing is temporarily unavailable. Please try again later.";
    } else {
      const localizedPrices = await checkout.previewPrices();
      const pricesByOffer = new Map(localizedPrices.map((price) => [price.offerId, price]));
      const cards = state.offers.map((offer) => {
        const price = pricesByOffer.get(offer.id);
        const card = element("article", "", "offer");
        const copy = element("div", "");
        copy.append(
          element("h2", offer.name),
          element("p", `${offer.purchaseType === "one_time" ? "One-time purchase" : "Subscription"} · Quantity 1`),
        );
        const amount = element("strong", price?.formattedTotal ?? "Price unavailable");
        const button = element("button", "Buy securely");
        button.setAttribute("type", "button");
        button.disabled = !price;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await checkout.open({
              offerId: offer.id,
              successUrl: new URL("./success.html", window.location.href).href,
            });
          } catch (error) {
            status.textContent = safeCheckoutMessage(error);
          } finally {
            button.disabled = false;
          }
        });
        card.append(copy, amount, button);
        return card;
      });
      offers.replaceChildren(...cards);
      status.textContent = "Choose an offer to continue to secure checkout.";
    }
  } catch (error) {
    status.textContent = safeCheckoutMessage(error);
  }
}

void startCheckout();
window.addEventListener("beforeunload", () => checkout?.destroy(), { once: true });
