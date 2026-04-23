export default function LoadingCats() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px', gap: '8px' }}>
      <img
        src="/dog.gif"
        alt="loading"
        style={{ width: '120px', imageRendering: 'pixelated' }}
      />
    </div>
  );
}
