import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type Product, type TrialClaim, type TrialStatus } from "../../lib/api-client";
import { Button, Card, EmptyState, ErrorPanel, LoadingState, PageHeader, PaginationBar, Select, StatusBadge } from "../../components/ui";
import { useI18n } from "../../lib/i18n";

export function TrialsView() {
  const { t, formatDate } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<TrialClaim[]>([]);
  const [productId, setProductId] = useState("");
  const [status, setStatus] = useState<TrialStatus | "">("active");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [productsError, setProductsError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    void api.admin.products.list().then(
      (result) => { if (!cancelled) { setProducts(result.items); setProductsError(null) } },
      (caught) => { if (!cancelled) setProductsError(caught) },
    );
    return () => { cancelled = true };
  }, [revision]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    void api.admin.trials.list({ productId: productId || undefined, status: status || undefined, page, limit: 20 }).then(
      (result) => {
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.pagination?.total ?? result.items.length);
        setTotalPages(result.pagination?.totalPages ?? 1);
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setError(caught);
        setTotal(0);
        setTotalPages(0);
        setLoading(false);
      },
    );
    return () => { cancelled = true };
  }, [productId, status, page, revision]);

  function statusLabel(value: TrialStatus) {
    return value === "active" ? t.trials.filterActive : value === "expired" ? t.trials.filterExpired : t.trials.filterRevoked;
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t.trials.eyebrow}
        title={t.trials.title}
        description={t.trials.description}
        action={<Button variant="secondary" loading={loading} onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw className="size-4" />{t.common.refresh}
        </Button>}
      />
      <ErrorPanel error={productsError} />
      <ErrorPanel error={error} />
      <Card>
        <div className="filter-bar">
          <div className="filter-group">
            <Select className="filter-select" aria-label={t.trials.filterAllProducts} value={productId} onChange={(event) => {
              setProductId(event.target.value);
              setPage(1);
            }}>
              <option value="">{t.trials.filterAllProducts}</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </Select>
            <Select className="filter-select" aria-label={t.trials.filterAllStatuses} value={status} onChange={(event) => {
              setStatus(event.target.value as TrialStatus | "");
              setPage(1);
            }}>
              <option value="">{t.trials.filterAllStatuses}</option>
              <option value="active">{t.trials.filterActive}</option>
              <option value="expired">{t.trials.filterExpired}</option>
              <option value="revoked">{t.trials.filterRevoked}</option>
            </Select>
          </div>
          {!loading && !error ? <strong>{t.trials.count(total)}</strong> : null}
        </div>
        {loading ? <LoadingState /> : error ? null : items.length === 0 ? (
          <EmptyState title={t.trials.emptyTitle} description={t.trials.emptyDesc} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t.trials.tableColTrial}</th>
                  <th>{t.trials.tableColProduct}</th>
                  <th>{t.trials.tableColStatus}</th>
                  <th>{t.trials.tableColClaimedAt}</th>
                  <th>{t.trials.tableColExpiresAt}</th>
                  <th>{t.trials.tableColLastValidatedAt}</th>
                </tr></thead>
                <tbody>{items.map((item) => <tr key={item.id}>
                  <td><code>{item.id}</code></td>
                  <td><strong>{item.productName}</strong></td>
                  <td><StatusBadge status={item.status} label={statusLabel(item.status)} /></td>
                  <td>{formatDate(item.claimedAt)}</td>
                  <td>{formatDate(item.expiresAt)}</td>
                  <td>{formatDate(item.lastValidatedAt)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <PaginationBar page={page} totalPages={totalPages} totalItems={total} loading={loading} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
