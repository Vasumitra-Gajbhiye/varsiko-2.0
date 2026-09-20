"""Capacity + spec_floor. Pure arithmetic over series, inventory, and named constants."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from surveyor.contracts import LockinDetail

DEFAULT_CONSTANTS: dict[str, Any] = {
    "burst_factor": 3.0,
    "sharp_cpu_multiplier": 1.0,
    "os_ram_gb": 1.0,
    "os_disk_gb": 20,
    "assume_cdn": False,
    "app_disk_gb": 1.5,
    "image_ram_gb": 1.0,
    "headroom_factor": 1.5,
    "cdn_headroom_factor": 2.0,
    "edge_share_threshold": 0.7,
    "floor_min_vcpu": 2,
    "floor_min_ram_gb": 4,
    "floor_min_disk_gb": 40,
    "isr_retention_proxy": 1.0,
}


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    xs = sorted(values)
    k = max(1, math.ceil(p * len(xs)))
    return xs[k - 1]


@dataclass
class HourlyPoint:
    ts: str
    value: float


@dataclass
class MetricSeries:
    label: str
    hourly: list[HourlyPoint] = field(default_factory=list)
    total: float = 0.0

    def values(self) -> list[float]:
        return [p.value for p in self.hourly]


@dataclass
class MetricsBundle:
    available: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)
    series: dict[str, MetricSeries] = field(default_factory=dict)
    edge_request_share: float = 0.0
    isr_operations: float = 0.0
    image_duration_s: float = 0.0
    image_optimized_gb: float = 0.0
    isr_write_gb: float = 0.0
    blob_gb: float = 0.0
    fdt_out_bytes: float = 0.0
    fot_out_bytes: float = 0.0
    window_days: int = 14
    top_routes: list[dict[str, Any]] = field(default_factory=list)
    p95_rps: float = 0.0
    peak_rps: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MetricsBundle":
        series = {}
        for key, raw in (data.get("series") or {}).items():
            hourly = [
                HourlyPoint(ts=str(p.get("ts", "")), value=float(p.get("value", 0)))
                for p in raw.get("hourly") or []
            ]
            series[key] = MetricSeries(
                label=str(raw.get("label") or key),
                hourly=hourly,
                total=float(raw.get("total") or 0),
            )
        return cls(
            available=list(data.get("available") or []),
            unavailable=list(data.get("unavailable") or []),
            series=series,
            edge_request_share=float(data.get("edge_request_share") or 0),
            isr_operations=float(data.get("isr_operations") or 0),
            image_duration_s=float(data.get("image_duration_s") or 0),
            image_optimized_gb=float(data.get("image_optimized_gb") or 0),
            isr_write_gb=float(data.get("isr_write_gb") or 0),
            blob_gb=float(data.get("blob_gb") or 0),
            fdt_out_bytes=float(data.get("fdt_out_bytes") or 0),
            fot_out_bytes=float(data.get("fot_out_bytes") or 0),
            window_days=int(data.get("window_days") or 14),
            top_routes=list(data.get("top_routes") or []),
            p95_rps=float(data.get("p95_rps") or 0),
            peak_rps=float(data.get("peak_rps") or 0),
        )


@dataclass
class CapacityResult:
    vcpu: int
    ram_gb: int
    disk_gb: int
    egress_tb: float
    headroom_factor: float
    derived_from: str
    spec_floor: dict[str, Any]
    constants: dict[str, Any]
    method: dict[str, str]
    capacity_if_cdn: dict[str, Any]
    evidence_conflicts: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    confidence: str = "high"
    p95_active_cores: float = 0.0
    p95_provisioned_mem_gb: float = 0.0
    p95_peak_mem_gb: float = 0.0

    def capacity_block(self) -> dict[str, Any]:
        return {
            "vcpu": self.vcpu,
            "ram_gb": self.ram_gb,
            "disk_gb": self.disk_gb,
            "egress_tb": self.egress_tb,
            "headroom_factor": self.headroom_factor,
            "derived_from": self.derived_from,
            "source": "rule:capacity",
        }


def _uses_image(lockin: list[LockinDetail]) -> bool:
    return any(d.feature == "next/image" for d in lockin)


def _blob_gb(lockin: list[LockinDetail], metrics: MetricsBundle) -> float:
    if metrics.blob_gb:
        return metrics.blob_gb
    total = 0.0
    for d in lockin:
        impact = d.capacity_impact or {}
        if "disk_gb" in impact and d.feature == "@vercel/blob":
            total += float(impact["disk_gb"])
    return total


def _headroom(metrics: MetricsBundle, constants: dict[str, Any], assume_cdn: bool) -> float:
    base = float(constants["headroom_factor"])
    if not assume_cdn and metrics.edge_request_share > float(constants["edge_share_threshold"]):
        return float(constants["cdn_headroom_factor"])
    return base


def _compute(
    metrics: MetricsBundle,
    lockin: list[LockinDetail],
    constants: dict[str, Any],
    *,
    assume_cdn: bool,
    billing_bandwidth_tb: float | None = None,
) -> tuple[int, int, int, float, float, list[str], float, float, float]:
    cpu_series = metrics.series.get("active_cpu_s")
    cores = []
    if cpu_series and cpu_series.hourly:
        cores = [v / 3600.0 for v in cpu_series.values()]
    p95_cores = percentile(cores, 0.95) if cores else 0.0
    image_cpu = metrics.image_duration_s * float(constants["sharp_cpu_multiplier"]) / 3600.0
    static_cpu = 0.0
    vcpu = int(
        math.ceil(
            p95_cores * float(constants["burst_factor"]) + image_cpu + static_cpu
        )
    )
    if vcpu < 1 and (cpu_series or metrics.available):
        vcpu = max(vcpu, 1)
    if not cores and not metrics.available:
        vcpu = int(constants["floor_min_vcpu"])

    prov = metrics.series.get("provisioned_mem_gb")
    peak = metrics.series.get("peak_mem_gb")
    p95_prov = percentile(prov.values(), 0.95) if prov and prov.hourly else 0.0
    p95_peak = percentile(peak.values(), 0.95) if peak and peak.hourly else 0.0
    image_ram = float(constants["image_ram_gb"]) if _uses_image(lockin) else 0.0
    ram_raw = max(p95_prov, math.ceil(max(vcpu, 1)) * p95_peak) + float(
        constants["os_ram_gb"]
    ) + image_ram
    ram_gb = int(math.ceil(ram_raw)) if (prov or peak or _uses_image(lockin)) else int(
        constants["floor_min_ram_gb"]
    )
    if not prov and not peak and metrics.available:
        ram_gb = int(math.ceil(float(constants["os_ram_gb"]) + image_ram + max(vcpu, 1)))

    blob = _blob_gb(lockin, metrics)
    disk_inner = (
        float(constants["app_disk_gb"])
        + metrics.image_optimized_gb
        + metrics.isr_write_gb * float(constants["isr_retention_proxy"])
        + blob
    )
    disk_gb = int(math.ceil(disk_inner * _headroom(metrics, constants, assume_cdn) + float(constants["os_disk_gb"])))

    window = max(metrics.window_days, 1)
    egress_bytes = metrics.fdt_out_bytes + metrics.fot_out_bytes
    egress_tb = (egress_bytes / 1e12) * (30.0 / window) if egress_bytes else 0.0

    conflicts: list[str] = []
    if billing_bandwidth_tb is not None and egress_tb > 0:
        denom = max(egress_tb, billing_bandwidth_tb, 1e-9)
        if abs(egress_tb - billing_bandwidth_tb) / denom > 0.25:
            conflicts.append(
                f"egress metric {egress_tb:.3f} TB vs billing {billing_bandwidth_tb:.3f} TB"
            )

    hf = _headroom(metrics, constants, assume_cdn)
    return vcpu, ram_gb, disk_gb, egress_tb, hf, conflicts, p95_cores, p95_prov, p95_peak


def derive_capacity(
    metrics: MetricsBundle | dict[str, Any] | None,
    lockin_detail: list[LockinDetail] | list[dict[str, Any]],
    *,
    constants: dict[str, Any] | None = None,
    billing_bandwidth_tb: float | None = None,
    function_memory_gb: float | None = None,
    observability: bool = True,
) -> CapacityResult:
    const = dict(DEFAULT_CONSTANTS)
    if constants:
        const.update(constants)
    bundle = (
        metrics
        if isinstance(metrics, MetricsBundle)
        else MetricsBundle.from_dict(metrics or {})
    )
    details: list[LockinDetail] = []
    for item in lockin_detail:
        if isinstance(item, LockinDetail):
            details.append(item)
        else:
            details.append(LockinDetail.model_validate(item))

    if not observability or (bundle.unavailable and not bundle.available):
        vcpu = int(const["floor_min_vcpu"])
        ram = int(function_memory_gb or const["floor_min_ram_gb"])
        disk = int(const["floor_min_disk_gb"])
        if _uses_image(details):
            ram = max(ram, int(const["floor_min_ram_gb"]) + 1)
        blob = _blob_gb(details, bundle)
        if blob:
            disk = int(math.ceil((float(const["app_disk_gb"]) + blob) * const["headroom_factor"] + const["os_disk_gb"]))
        egress = billing_bandwidth_tb or 0.0
        hf = float(const["headroom_factor"])
        floor = _spec_floor(vcpu, ram, disk, egress, hf, const)
        return CapacityResult(
            vcpu=vcpu,
            ram_gb=ram,
            disk_gb=disk,
            egress_tb=float(egress),
            headroom_factor=hf,
            derived_from="billing ConsumedQuantity + function manifest; observability unavailable",
            spec_floor=floor,
            constants=const,
            method=_method_text(const),
            capacity_if_cdn={"vcpu": vcpu, "ram_gb": ram, "disk_gb": disk, "egress_tb": egress, "headroom_factor": 1.5},
            warnings=["OBSERVABILITY_PLUS_REQUIRED"] if not observability else [],
            confidence="low",
        )

    if function_memory_gb and "peak_mem_gb" not in bundle.series:
        bundle.series["peak_mem_gb"] = MetricSeries(
            label="fallback peak",
            hourly=[HourlyPoint(ts="fallback", value=float(function_memory_gb))],
        )

    vcpu, ram, disk, egress, hf, conflicts, p95_cores, p95_prov, p95_peak = _compute(
        bundle, details, const, assume_cdn=bool(const["assume_cdn"]), billing_bandwidth_tb=billing_bandwidth_tb
    )
    cdn_vcpu, cdn_ram, cdn_disk, cdn_egress, cdn_hf, _, _, _, _ = _compute(
        bundle, details, const, assume_cdn=True, billing_bandwidth_tb=None
    )
    floor = _spec_floor(vcpu, ram, disk, egress, hf, const)
    derived = (
        f"p95 of {bundle.window_days}d hourly Function Invocations Active CPU; "
        f"see surveyor.method"
    )
    confidence = "high"
    if conflicts:
        confidence = "medium"
    return CapacityResult(
        vcpu=vcpu,
        ram_gb=ram,
        disk_gb=disk,
        egress_tb=round(egress, 4),
        headroom_factor=hf,
        derived_from=derived,
        spec_floor=floor,
        constants=const,
        method=_method_text(const),
        capacity_if_cdn={
            "vcpu": cdn_vcpu,
            "ram_gb": cdn_ram,
            "disk_gb": cdn_disk,
            "egress_tb": round(cdn_egress, 4),
            "headroom_factor": cdn_hf,
            "source": "constant:assume_cdn",
        },
        evidence_conflicts=conflicts,
        confidence=confidence,
        p95_active_cores=p95_cores,
        p95_provisioned_mem_gb=p95_prov,
        p95_peak_mem_gb=p95_peak,
    )


def _spec_floor(
    vcpu: int, ram: int, disk: int, egress: float, hf: float, const: dict[str, Any]
) -> dict[str, Any]:
    # Shop the derived demand, clamped to named mins. Capacity already includes
    # burst_factor (CPU) and headroom (disk); multiplying again landed between
    # Hetzner CPX31 and CPX41 and made the Surveyor file unshoppable.
    return {
        "vcpu": max(int(vcpu), int(const["floor_min_vcpu"])),
        "ram_gb": max(int(ram), int(const["floor_min_ram_gb"])),
        "disk_gb": max(int(disk), int(const["floor_min_disk_gb"])),
        "egress_tb": round(float(egress), 4),
        "source": "rule:spec_floor",
        "headroom_recorded": hf,
    }


def _method_text(const: dict[str, Any]) -> dict[str, str]:
    return {
        "cpu": "ceil( p95_hourly(active_cpu_s)/3600 * burst_factor + image_cpu + static_cpu )",
        "ram": "max( p95(provisioned_mem_gb), ceil(vcpu) * p95(peak_mem_gb) ) + os_ram_gb + image_ram",
        "egress": "30d-scaled sum(Fast Data Transfer Out + Fast Origin Transfer Out); cross-checked against billing",
        "disk": "(app 1.5 + image cache + ISR cache + blob) * headroom + os_disk_gb",
    }


def static_default_capacity(constants: dict[str, Any] | None = None) -> CapacityResult:
    const = dict(DEFAULT_CONSTANTS)
    if constants:
        const.update(constants)
    vcpu = int(const["floor_min_vcpu"])
    ram = int(const["floor_min_ram_gb"])
    disk = int(const["floor_min_disk_gb"])
    hf = float(const["headroom_factor"])
    return CapacityResult(
        vcpu=vcpu,
        ram_gb=ram,
        disk_gb=disk,
        egress_tb=0.0,
        headroom_factor=hf,
        derived_from="default:static-only floor 2/4/40",
        spec_floor=_spec_floor(vcpu, ram, disk, 0.0, hf, const),
        constants=const,
        method=_method_text(const),
        capacity_if_cdn={"vcpu": vcpu, "ram_gb": ram, "disk_gb": disk, "egress_tb": 0.0, "headroom_factor": 1.5},
        warnings=["NO_LIVE_DATA"],
        confidence="low",
    )
