import React, { useMemo } from 'react';
import {
  AlertTriangle,
  Armchair,
  BadgeCheck,
  Boxes,
  Car,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Package,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useAssetPhotos, useEmployeeAssets } from '../data/assets';
import PageHeader from './ui/PageHeader';

const categoryIcon = (asset) => {
  if (asset?.category === 'Software') return KeyRound;
  if (asset?.category === 'Vehicle') return Car;
  if (asset?.category === 'Furniture') return Armchair;
  if (asset?.asset_type === 'Laptop' || asset?.asset_type === 'Desktop') return Laptop;
  if (asset?.asset_type === 'Mobile' || asset?.asset_type === 'Tablet') return Smartphone;
  if (asset?.asset_type === 'Monitor') return Monitor;
  return Package;
};

const assetSubtitle = (asset) =>
  [
    asset.asset_code,
    asset.asset_type || asset.category,
    [asset.make, asset.model].filter(Boolean).join(' '),
    asset.serial ? `Serial ${asset.serial}` : null,
  ]
    .filter(Boolean)
    .join(' · ') || 'Company asset';

export default function MyAssets() {
  const { employee } = useAuth();
  const { data: assets = [], isLoading, error } = useEmployeeAssets(employee?.id);
  const { data: photoUrls = {} } = useAssetPhotos(assets);
  const stats = useMemo(() => {
    const categories = new Set(assets.map((asset) => asset.category).filter(Boolean));
    return [
      { label: 'Holding', value: assets.length, sub: assets.length === 1 ? 'asset assigned' : 'assets assigned' },
      { label: 'Categories', value: categories.size, sub: 'types of company property' },
    ];
  }, [assets]);

  return (
    <div className="page-shell people-page space-y-5 animate-fade-in">
      <PageHeader
        eyebrow="My Workspace"
        icon={Boxes}
        title="My Assets"
        subtitle="Company property currently assigned to you."
      />

      {!employee?.id ? (
        <div className="premium-card flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" role="alert">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>Your login is not linked to an employee profile yet.</span>
        </div>
      ) : isLoading ? (
        <div className="premium-card flex justify-center py-10 text-[#0ea971]">
          <Loader2 size={22} className="animate-spin" />
        </div>
      ) : error ? (
        <div className="premium-card flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" role="alert">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error.message}</span>
        </div>
      ) : assets.length === 0 ? (
        <div className="people-empty-state">
          <Boxes size={26} />
          <strong>No assets assigned</strong>
          <span>Nothing is currently signed out to you.</span>
        </div>
      ) : (
        <>
          <section className="people-insight-grid">
            {stats.map((stat) => (
              <div key={stat.label} className="people-insight-card" data-tone="green">
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
                <em>{stat.sub}</em>
              </div>
            ))}
          </section>

          <ul className="my-assets-list">
            {assets.map((asset) => {
              const Icon = categoryIcon(asset);
              return (
                <li key={asset.id} className="my-asset-card">
                  <span className="my-asset-media" data-photo={photoUrls[asset.id] ? 'true' : 'false'}>
                    {photoUrls[asset.id] ? <img src={photoUrls[asset.id]} alt="" loading="lazy" /> : <Icon size={18} />}
                  </span>
                  <span className="my-asset-copy">
                    <strong>{asset.name}</strong>
                    <em>{assetSubtitle(asset)}</em>
                    {asset.location && <small>{asset.location}</small>}
                  </span>
                  <span className="my-asset-condition">
                    <BadgeCheck size={13} />
                    {asset.condition || asset.status || 'Assigned'}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
