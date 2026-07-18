import type { RunHistoryEntry } from '../types.js';

interface RawMtrPanelProps {
  run: RunHistoryEntry | null;
}

export function RawMtrPanel({ run }: RawMtrPanelProps) {
  return (
    <div className="raw-mtr-panel">
      <h3>Raw MTR Values</h3>
      {run && (
        <div className="raw-mtr-run">
          <div className="raw-mtr-run-header">{new Date(run.startedAt).toLocaleString()}</div>
          <table className="raw-mtr-table">
            <thead>
              <tr>
                <th>ttl</th>
                <th>host</th>
                <th>loss%</th>
                <th>snt</th>
                <th>last</th>
                <th>avg</th>
                <th>best</th>
                <th>wrst</th>
                <th>stdev</th>
              </tr>
            </thead>
            <tbody>
              {run.hops.map((hop) => (
                <tr key={hop.ttl}>
                  <td>{hop.ttl}</td>
                  <td>{hop.host}</td>
                  <td>{hop.lossPct}</td>
                  <td>{hop.snt}</td>
                  <td>{hop.last}</td>
                  <td>{hop.avg}</td>
                  <td>{hop.best}</td>
                  <td>{hop.wrst}</td>
                  <td>{hop.stdev}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
