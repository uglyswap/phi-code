---
description: "Performance profiling, optimization, caching, and benchmarking"
---
# Performance Optimization Skill

## When to use
Profiling, optimizing, caching, reducing latency or resource usage.

## Profiling First
- Never optimize without profiling first
- Measure before and after every change
- Focus on the bottleneck (Amdahl's Law)

## Node.js
```bash
# CPU profiling
node --prof app.js
node --prof-process isolate-*.log > profile.txt

# Memory profiling
node --inspect app.js
# Then use Chrome DevTools → Memory tab

# Benchmarking
hyperfine 'node script.js'
```

## Common Optimizations
### Caching
- In-memory: LRU cache for hot data
- Redis/Memcached for distributed cache
- HTTP caching: `Cache-Control`, `ETag`, `Last-Modified`
- CDN for static assets

### Database
- Add missing indexes (check `EXPLAIN ANALYZE`)
- Connection pooling
- Batch operations instead of N+1 queries
- Denormalize for read-heavy tables
- Use materialized views for complex aggregations

### Network
- Enable compression (gzip/brotli)
- Minimize payload size
- Use HTTP/2 or HTTP/3
- Connection keep-alive
- Lazy loading for non-critical resources

### Code
- Avoid unnecessary allocations in hot paths
- Use streams for large data processing
- Parallelize independent I/O operations (`Promise.all`)
- Debounce/throttle high-frequency operations
- Use worker threads for CPU-intensive tasks

## Benchmarking Rules
- Warm up before measuring
- Run multiple iterations
- Report median, not mean (avoid outlier influence)
- Control for external factors (other processes, network)
