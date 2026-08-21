# ReqLoop 部署感知

## 理念与概念

ReqLoop 用 `Product`、`Component`、`Environment` 和 `Service` 表达当前部署视图：

- `Product` 是部署目录的稳定 owner，收拢属于同一产品的 Component、Environment 和 Service。
- `Component` 是 Product 内的静态软件单元，可通过 `{forge, path}` 登记一个主代码仓库。
- `Environment` 是 Product 的 dev、test、poc 等逻辑部署环境，并拥有组成该环境的部署基础设施 target。
  Kubernetes 是当前已支持的 target 类型，但 Environment 不等同于 Kubernetes 集群，也允许暂时
  没有 Kubernetes target。
- `Service` 是一个 Component 在同一 Product 的 Environment 中的实例。它引用 Environment 内的 target，
  并声明实现该实例的 Deployment、Service、ConfigMap 等对象。

四者都位于用户全局 `v1` namespace。集群是客观存在的共享基础设施，不随 Baton Session 或
Project 复制；Project 下的开发 Resource 后续可通过稳定身份与这些全局 Resource 建立关系。
Component 的 repository 使用与 Project 下 Repository、PullRequest 相同的外部稳定身份，不引用某个
Project Repository Resource 的 `uid`。因此 Service 可经 Component 连接代码仓和 Requirement；多个
Component 也可以共享同一个 repository，以覆盖 monorepo 场景。

## 主流程

```text
global config
    └── Product spec
          ├── Component spec ──code-in──▶ Repository identity
          ├── Environment spec ──owns──▶ Kubernetes target
          └── Service spec ──uses──────▶ target + Kubernetes object mapping
                                      │
                                      ▼
                              KubernetesConnector
                                      │
                                      ▼
                   revision / artifacts / readiness / object versions
                                      │
                                      ▼
                              Service Resource status
```

配置 Source 只负责物化集合。EnvironmentController 周期观察 target 是否可访问以及集群版本；
ServiceController 读取对应 Environment 和 target，再观察已经声明的 Kubernetes 对象。Environment
状态变化还会通过 Watch 唤醒相关 Service，使 target 恢复或失效能尽快反映到 Service。

当前只做只读感知，不创建、更新、重启或删除 Kubernetes 对象。Service status 是最后一次已知
部署事实，不是发布历史；因此当前不引入 Release 或 Deployment Resource。

## Kubernetes target 与 Connector

Environment spec 保存 Kubernetes target 的稳定 `name`、Connector `source` 和外部 cluster
身份。这些信息属于共享部署模型，不能只藏在 Connector 配置里。kubeconfig、context 等访问细节
仍归 Connector，并且只从 Plugin global config 读取，避免 Project 或 Session 配置改写全局事实。

每次观察使用带明确 kubeconfig、请求超时和输出上限的 `kubectl` 子进程：

- `kubectl version` 判断 target 可访问性和服务端版本；
- 一次有界 `kubectl get` 同时读取 Service 声明的 Deployment、Service 和 ConfigMap；
- Deployment 的 generation、ready/updated/available replicas 与失败 condition 决定
  `ready / progressing / degraded`；调用失败或对象缺失表现为 `unavailable`。

`deployedRevision` 优先读取 Pod template 或 Deployment 上的
`reqloop.compforge.dev/revision` annotation、`app.kubernetes.io/version` label，最后退化为
容器镜像列表。`artifacts` 保留完整镜像引用，`objects` 保存所观察对象的 resourceVersion，
使后续 Quality Plugin 能按 Service Resource 变化触发针对目标 Environment 的 e2e，而无需理解
kubeconfig 或 kubectl 输出。

## 边界

- Product 拥有部署目录，Component 与 Environment 的身份都包含 Product。
- Environment 拥有部署 target；Connector 只负责协议读取和 DTO 映射。
- Service spec 保存用户认可的对象映射，status 保存可重新观察的集群事实。
- Product、Component、Environment、Service 的集合来自 global config；一次 Source omission 不代表删除。
- K8s 写操作、发布策略、凭据分发、发布历史与 Quality 执行不属于当前能力。
