type StatCardProps = {
  title: string;
  value: string | number;
};

export default function StatCard({ title, value }: StatCardProps) {
  return (
    <div className="card">
      <div className="card__label">{title}</div>
      <div className="card__value">{value}</div>
    </div>
  );
}