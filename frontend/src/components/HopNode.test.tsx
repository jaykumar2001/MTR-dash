import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { HopNode, type HopNodeData } from './HopNode.js';

function renderNode(data: HopNodeData) {
  return render(
    <ReactFlowProvider>
      <HopNode
        id="1"
        data={data}
        type="hopNode"
        selected={false}
        zIndex={0}
        isConnectable={true}
        dragging={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        selectable={true}
        deletable={true}
        draggable={true}
      />
    </ReactFlowProvider>,
  );
}

describe('HopNode', () => {
  it('renders the host and ttl', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('ttl 3')).toBeInTheDocument();
  });

  it('applies the inactive class when not active', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: false });
    expect(container.querySelector('.hop-node.inactive')).not.toBeNull();
  });

  it('renders the netname when present', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true, netname: 'EXAMPLE-NET' });
    expect(screen.getByText('EXAMPLE-NET')).toBeInTheDocument();
  });

  it('renders nothing extra when netname is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-netname')).toBeNull();
  });

  it('renders the resolved hostname when present', () => {
    renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      resolvedHost: 'router.example.com',
    });
    expect(screen.getByText('router.example.com')).toBeInTheDocument();
  });

  it('renders nothing extra when resolvedHost is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-hostname')).toBeNull();
  });

  it('renders the city and country together when both are present', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true, country: 'DE', city: 'Frankfurt' });
    expect(screen.getByText('Frankfurt, DE')).toBeInTheDocument();
  });

  it('renders the city alone when country is absent', () => {
    renderNode({ host: '192.168.1.1', ttl: 3, active: true, city: 'Frankfurt' });
    expect(screen.getByText('Frankfurt')).toBeInTheDocument();
  });

  it('renders nothing extra when city is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-geo')).toBeNull();
  });

  it('renders a country flag when a recognized country code is present', () => {
    const { container } = renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      country: 'US',
    });
    expect(container.querySelector('.hop-node-flag')).not.toBeNull();
    expect(container.querySelector('.hop-node-flag svg')).not.toBeNull();
  });

  it('renders no flag when country is absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node-flag')).toBeNull();
  });

  it('renders no flag for an unrecognized country code', () => {
    const { container } = renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      country: 'ZZ-NOT-REAL',
    });
    expect(container.querySelector('.hop-node-flag')).toBeNull();
  });

  it('applies the dimmed class when dimmed is true', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true, dimmed: true });
    expect(container.querySelector('.hop-node.dimmed')).not.toBeNull();
  });

  it('does not apply the dimmed class when dimmed is false or absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node.dimmed')).toBeNull();
  });

  it('applies the path-highlighted class when highlighted is true', () => {
    const { container } = renderNode({
      host: '192.168.1.1',
      ttl: 3,
      active: true,
      highlighted: true,
    });
    expect(container.querySelector('.hop-node.path-highlighted')).not.toBeNull();
  });

  it('does not apply the path-highlighted class when highlighted is false or absent', () => {
    const { container } = renderNode({ host: '192.168.1.1', ttl: 3, active: true });
    expect(container.querySelector('.hop-node.path-highlighted')).toBeNull();
  });
});
