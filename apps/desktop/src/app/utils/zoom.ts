export function formatZoomPercentage(zoom: number) {
    const percentage = zoom * 100;
    const roundedPercentage = Math.round(percentage);

    if (Math.abs(percentage - roundedPercentage) < 0.05) {
        return `${roundedPercentage}%`;
    }

    return `${percentage.toFixed(1)}%`;
}
