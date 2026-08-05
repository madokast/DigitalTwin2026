package httpx

import (
	"net/http"
	"strings"
)

// 自写路由器替代 http.ServeMux（docs/20260805-rfc9457-followups.md D3）：
// ServeMux 匹配失败时在中间件下游就地写死 text/plain 404/405（响应已定型不可逆），
// 迫使 withJSONErrorPages 先整体缓冲才有「先看结果再改写」的窗口。
// 自写路由把匹配握在自己手里——匹配失败直接输出 problem+json，消除双缓冲。

// route 单条路由：方法 + 精确路径 + handler。
type route struct {
	method  string
	path    string
	handler http.HandlerFunc
}

// router 精确路径路由器。本项目 18 个路由全为精确路径（无通配符）。
type router struct {
	routes []route
}

// HandleFunc 注册「方法 + 路径 → handler」。
func (rt *router) HandleFunc(method, path string, handler http.HandlerFunc) {
	rt.routes = append(rt.routes, route{method: method, path: path, handler: handler})
}

// ServeHTTP 匹配并分发；无匹配 → 404；路径匹配但方法不符 → 405 + Allow。
func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var allowed []string
	for _, rt := range rt.routes {
		if rt.path != r.URL.Path {
			continue
		}
		if rt.method == r.Method {
			rt.handler(w, r)
			return
		}
		allowed = append(allowed, rt.method)
	}
	if len(allowed) > 0 {
		w.Header().Set("Allow", joinUnique(allowed))
		writeError(w, http.StatusMethodNotAllowed, "method not allowed: "+r.Method+" "+r.URL.Path)
		return
	}
	writeError(w, http.StatusNotFound, "unknown path: "+r.URL.Path)
}

// joinUnique 去重并保留注册顺序，拼 Allow header 值。
func joinUnique(methods []string) string {
	seen := make(map[string]bool)
	var out []string
	for _, m := range methods {
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return strings.Join(out, ", ")
}
