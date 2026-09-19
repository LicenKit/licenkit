import { useEffect, useRef, useState } from "react";
import {
  createLicenKitCheckout,
  LicenKitCheckoutError,
  type CheckoutState,
  type LicenKitCheckout,
  type LocalizedPrice,
} from "@licenkit/checkout";
import { readCheckoutConfig } from "./config";

function safeCheckoutMessage(error: unknown): string {
  if (!(error instanceof LicenKitCheckoutError)) return "Checkout is temporarily unavailable.";
  switch (error.code) {
    case "CHECKOUT_NOT_AVAILABLE":
      return "Purchasing is temporarily unavailable. Please try again later.";
    case "PADDLE_CHECKOUT_ORIGIN_UNAVAILABLE":
      return "Checkout is not enabled for this website yet.";
    case "CHECKOUT_OFFER_NOT_FOUND":
      return "This offer is no longer available. Refresh the page to see current offers.";
    default:
      return "Checkout could not be loaded. Please try again later.";
  }
}

export function App() {
  const checkoutRef = useRef<LicenKitCheckout | null>(null);
  const [state, setState] = useState<CheckoutState | null>(null);
  const [prices, setPrices] = useState<Map<string, LocalizedPrice>>(new Map());
  const [message, setMessage] = useState("Loading current offers…");
  const [openingOfferId, setOpeningOfferId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    try {
      const checkout = createLicenKitCheckout({
        ...readCheckoutConfig(),
        onEvent(event) {
          if (!active) return;
          if (event.type === "checkout.completed") {
            setMessage("Payment submitted. Your license will be sent by email after server verification.");
          } else if (event.type === "checkout.error") {
            setMessage("The payment window reported an error. Please try again.");
          }
        },
      });
      checkoutRef.current = checkout;
      void (async () => {
        try {
          const nextState = await checkout.load();
          if (!active) return;
          setState(nextState);
          if (!nextState.available) {
            setMessage("Purchasing is temporarily unavailable. Please try again later.");
            return;
          }
          const localizedPrices = await checkout.previewPrices();
          if (!active) return;
          setPrices(new Map(localizedPrices.map((price) => [price.offerId, price])));
          setMessage("Choose an offer to continue to secure checkout.");
        } catch (error) {
          if (active) setMessage(safeCheckoutMessage(error));
        }
      })();
    } catch (error) {
      setMessage(safeCheckoutMessage(error));
    }

    return () => {
      active = false;
      checkoutRef.current?.destroy();
      checkoutRef.current = null;
    };
  }, []);

  async function openCheckout(offerId: string) {
    const checkout = checkoutRef.current;
    if (!checkout) return;
    setOpeningOfferId(offerId);
    try {
      await checkout.open({
        offerId,
        successUrl: new URL("./success.html", window.location.href).href,
      });
    } catch (error) {
      setMessage(safeCheckoutMessage(error));
    } finally {
      setOpeningOfferId(null);
    }
  }

  return (
    <main className="shell">
      <section className="card" aria-labelledby="product-title">
        <p className="eyebrow">Licensed software</p>
        <h1 id="product-title">{state?.product.name ?? "Product checkout"}</h1>
        {state?.product.description ? <p className="description">{state.product.description}</p> : null}
        <p className="status" aria-live="polite">{message}</p>
        <div className="offers">
          {state?.offers.map((offer) => {
            const price = prices.get(offer.id);
            const disabled = !state.available || !price || openingOfferId !== null;
            return (
              <article className="offer" key={offer.id}>
                <div>
                  <h2>{offer.name}</h2>
                  <p>{offer.purchaseType === "one_time" ? "One-time purchase" : "Subscription"} · Quantity 1</p>
                </div>
                <strong>{price?.formattedTotal ?? "Price unavailable"}</strong>
                <button type="button" disabled={disabled} onClick={() => void openCheckout(offer.id)}>
                  {openingOfferId === offer.id ? "Opening…" : "Buy securely"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
