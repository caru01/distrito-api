UPDATE pedidos_app_orders AS orders
SET cart_json = compact.cart_json,
    updated_at = NOW()
FROM (
  SELECT o.id,
         COALESCE(
           jsonb_agg(
             jsonb_strip_nulls(
               jsonb_build_object(
                 'id', item.value -> 'id',
                 'title', item.value -> 'title',
                 'price', item.value -> 'price',
                 'category', item.value -> 'category',
                 'quantity', COALESCE(item.value -> 'quantity', item.value -> 'qty', '1'::jsonb)
               )
             ) ORDER BY item.ordinality
           ),
           '[]'::jsonb
         ) AS cart_json
  FROM pedidos_app_orders o
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(o.cart_json, '[]'::jsonb))
    WITH ORDINALITY AS item(value, ordinality) ON TRUE
  GROUP BY o.id
) AS compact
WHERE compact.id = orders.id
  AND orders.cart_json IS DISTINCT FROM compact.cart_json;
