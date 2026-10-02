export function ProductCard({ name, price }: { name: string; price: string }) {
  return (
    <article>
      <h3>{name}</h3>
      <p>{price}</p>
      <button type="button">Add to cart</button>
    </article>
  );
}
