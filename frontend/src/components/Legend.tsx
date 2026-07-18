export function Legend() {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="dot green" /> 0% loss
      </span>
      <span className="legend-item">
        <span className="dot yellow" /> &gt;0-5% loss
      </span>
      <span className="legend-item">
        <span className="dot red" /> &gt;5% loss
      </span>
    </div>
  );
}
