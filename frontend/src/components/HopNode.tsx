import { Handle, Position, type NodeProps } from '@xyflow/react';
import * as Flags from 'country-flag-icons/react/3x2';
import { Copyable } from './Copyable.js';

export interface HopNodeData extends Record<string, unknown> {
  host: string;
  ttl: number;
  active: boolean;
  netname?: string | null;
  country?: string | null;
  city?: string | null;
  resolvedHost?: string | null;
  inferred?: boolean;
}

// `Flags` exports one component per ISO 3166-1 alpha-2 code (e.g. `Flags.US`);
// country codes come from the geoip lookup (a data source, not a fixed enum
// at compile time), so this is always a dynamic, string-keyed lookup.
const FlagComponents = Flags as unknown as Record<string, React.ComponentType>;

export function HopNode({ data }: NodeProps) {
  const { host, ttl, active, netname, country, city, resolvedHost, inferred } =
    data as HopNodeData;
  const isOrigin = ttl === 0;
  const FlagIcon = country ? FlagComponents[country] : undefined;

  return (
    <div
      className={`hop-node ${active ? 'active' : 'inactive'}${isOrigin ? ' origin' : ''}${inferred ? ' inferred' : ''}`}
      title={inferred ? 'Inferred from an earlier resolved path — not observed responding in this poll' : ''}
    >
      <Handle type="target" position={Position.Left} />
      <div className="hop-node-ttl">
        {isOrigin ? 'origin' : `ttl ${ttl}`}
        {FlagIcon && (
          <span className="hop-node-flag" title={country ?? undefined}>
            <FlagIcon />
          </span>
        )}
      </div>
      <div className="hop-node-host">
        <Copyable text={host} />
      </div>
      {resolvedHost && <div className="hop-node-hostname">{resolvedHost}</div>}
      {city && <div className="hop-node-geo">{country ? `${city}, ${country}` : city}</div>}
      {netname && <div className="hop-node-netname">{netname}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
