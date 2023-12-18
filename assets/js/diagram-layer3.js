/*global d3, _, visioExport*/
"use strict"

const Diagram = function() {
  // localStorage feature detection
  const hasStorage = (() => {
    let mod = "storage test"
    try {
      localStorage.setItem(mod, mod)
      localStorage.removeItem(mod)
      return true
    } catch (exception) {
      return false
    }
  })()

  const Utils = {
    isFixed({ focusedGroup }, node) {
      return node.fx != null
        ||
        node.nodes && (
          node.nodes.some(n => n.fx != null)
          ||
          focusedGroup === node.id
        )
    },
    haveIntersection({ settings }, r1, r2) {
      const { groupBorderWidth } = settings

      return !(
        r2.x - groupBorderWidth > r1.x + r1.width ||
        r2.x + r2.width < r1.x - groupBorderWidth ||
        r2.y - groupBorderWidth > r1.y + r1.height ||
        r2.y + r2.height < r1.y - groupBorderWidth
      )
    },
    inInteractMode() {
      return d3.event.shiftKey || d3.event.sourceEvent?.shiftKey
    },
    findNode({ nodes }, value) {
      return nodes.find(node => node.subnet === value || node.name === value)
    },
    findAndFocus(diagram, value) {
      const node = this.findNode(diagram, value)

      if (node) {
        Zoom.focusOnNode(diagram, node)
        return true
      } else {
        return false
      }
    },
    registerDocumentEventListener({ docEventListeners }, type, listener) {
      document.addEventListener(type, listener)
      docEventListeners.push([type, listener])
    },
    cleanEventListeners({ docEventListeners }) {
      docEventListeners.forEach(([type, listener]) => document.removeEventListener(type, listener))
    },
    isWidget() {
      return window.psDashboardWidgetMode
    },
    parseJSON(value) {
      if (typeof value !== "string") return value

      try {
        return JSON.parse(value)
      } catch(e) {
        console.error(e)
        return false
      }
    }
  }

  // -- storage --
  const Store = {
    keyPrefix: "diagrams",
    key({ id }, path) { return `${this.keyPrefix}.${id}.${path}` },
    set(diagram, key, value) {
      if (!hasStorage) return false
      localStorage.setItem(this.key(diagram, key), value)
      return true
    },
    get(diagram, key) {
      if (!hasStorage) return null
      return localStorage.getItem(this.key(diagram, key))
    },
    getParsed(diagram, key) {
      return Utils.parseJSON(this.get(diagram, key))
    },
    remove(diagram, key) {
      if (!hasStorage) return false
      localStorage.removeItem(this.key(diagram, key))
    }
  }

  const Layout = {
    storageKey: "layout",
    get(diagram, layer) {
      const { settings } = diagram

      if (!layer) layer = diagram.currentLayer

      if (!diagram.layout) {
        diagram.layout = Utils.parseJSON(settings.layout ?? Store.get(diagram, this.storageKey)) ?? {}
      }

      return Utils.parseJSON(diagram.layout[layer.id])
    },
    restore(diagram) {
      const { nodes, groups } = diagram,
            layout = this.get(diagram)

      if (!layout) return

      // check stored layout nodes and current nodes
      if (layout.nodes) {
        layout.nodes.forEach(storedNode => {
          nodes.forEach(node => {
            // and for each match restore their fixed positions
            if (storedNode.name === node.name) {
              node.fx = storedNode.fx
              node.fy = storedNode.fy
            }
          })
        })
      }

      // check stored layout groups and current groups
      if (layout.groups) {
        layout.groups.forEach(storedGroup => {
          groups.forEach(group => {
            // and for each match restore their fixed positions
            if (storedGroup.name === group.name) {
              group.fx = storedGroup.fx
              group.fy = storedGroup.fy
            }
          })
        })
      }
    },
    clear(diagram) {
      Store.remove(diagram, this.storageKey)
    },
    save: _.debounce(function(diagram) {
      const { nodes, groups, currentLayer } = diagram,
            newLayout = JSON.stringify({ nodes, groups })

      if (diagram.layout[currentLayer.id] !== newLayout) {
        diagram.layout[currentLayer.id] = newLayout
        Store.set(diagram, this.storageKey, JSON.stringify(diagram.layout))
      }
    }, 1000)
  }

  const Zoom = {
    async focus({ dom, zoomBehavior }, { x, y, scale = 1, duration = 250 }) {
      const svgEl = dom.svg.node()

      dom.svg
        .transition()
        .duration(duration)
        .call(zoomBehavior.transform, d3.zoomIdentity.translate(
          svgEl.clientWidth / 2 - x * scale,
          svgEl.clientHeight / 2 - y * scale
        ).scale(scale))

      return new Promise(resolve => setTimeout(resolve, duration + 100))
    },
    async focusOnNode(diagram, node, scale, duration) {
      // node.fx = node.x
      // node.fy = node.y
      Simulations.stop(diagram)
      return this.focus(diagram, { x: node.x, y: node.y, scale, duration })
    },
    async focusOnArea(diagram, { cx, cy, width, height }, duration) {
      const { dom } = diagram,
            svgEl = dom.svg.node(),
            scale = 0.9 / Math.max(width / svgEl.clientWidth, height / svgEl.clientHeight)

      return this.focus(diagram, { x: cx, y: cy, scale, duration })
    },
    scale(layer, by) {
      let { zoomBehavior, dom, focusedGroup } = layer
      if (focusedGroup > -1) return

      zoomBehavior.scaleBy(dom.svg.transition().duration(200), by)
    },
    increment(layer) {
      this.scale(layer, layer.settings.zoomInMult)
    },
    decrement(layer) {
      this.scale(layer, layer.settings.zoomOutMult)
    },
    onWheelScroll(layer) {
      return function(event) {
        const { focusedGroup, settings } = layer
        let delta

        // if a group is focused don't zoom
        if (focusedGroup > -1) return

        if (event.wheelDelta) {
          delta = event.wheelDelta
        } else {
          delta = -1 * event.deltaY
        }

        Zoom.scale(layer, delta > 0 ? settings.zoomInMult : settings.zoomOutMult)
      }
    },
    transform: {
      storageKey: "transform",
      // debounced to avoid storing in localStorage multiple times during zoom or other events
      save: _.debounce(function(diagram, value) {
        return Store.set(diagram, this.storageKey, JSON.stringify(value))
      }, 1000),
      clear(diagram) {
        Store.remove(diagram, this.storageKey)
      },
      get(diagram) {
        const { dom, settings } = diagram
        // return either the provided value, the stored transform or the default one
        return Utils.parseJSON(settings.transform)
          ??
          Store.getParsed(diagram, this.storageKey)
          ??
          { x: dom.svg.node().clientWidth / 2, y: dom.svg.node().clientHeight / 2, k: 0.1 }
      },
    },
    applySettings({ settings, zoomBehavior }) {
      zoomBehavior.scaleExtent([settings.maxZoomOut, settings.maxZoomIn])
    },
    restrictArea({ zoomBehavior, transform, dom }, area) {
      if (!area) {
        const svgEl = dom.svg.node(),
              wiggleRoom = 0

        if (!transform) transform = { x: 0, y: 0, k: 1 }
        area = [
          [(-transform.x - wiggleRoom) / transform.k, (-transform.y - wiggleRoom) / transform.k],
          [
            (-transform.x + svgEl.clientWidth + (wiggleRoom)) / transform.k,
            (-transform.y + svgEl.clientHeight + (wiggleRoom)) / transform.k
          ]
        ]
      }
      return zoomBehavior.translateExtent(area)
    },
    clear(diagram) {
      this.transform.clear(diagram)
    },
    restore(diagram, layer) {
      const transform = this.transform.get(diagram)
      // restore saved transform or set the default one
      layer.dom.svg.call(
        diagram.zoomBehavior.transform,
        d3.zoomIdentity.translate(transform.x, transform.y).scale(transform.k)
      )
    },
    init(diagram, layer) {
      const { dom } = layer

      layer.zoomBehavior = d3.zoom()
        .on("zoom", () => {
          // don't zoom if a group is focused
          if (layer.focusedGroup > -1 && d3.event.sourceEvent && d3.event.sourceEvent.type === "mousemove") return

          layer.transform = d3.event.transform
          dom.layerContainer.attr("transform", d3.event.transform)
        })
        .on("end", () => {
          // save only when on main layer
          if (diagram.layers.length === 1) {
            this.transform.save(diagram, d3.event.transform)
          }
        })
      this.applySettings(diagram)

      dom.svg.call(layer.zoomBehavior)
        .on("wheel.zoom", null)
        .on("dblclick.zoom", null)
      dom.svg.node().addEventListener("wheel", this.onWheelScroll(layer))
    }
  }

  const Grouping = {
    fromNodes(diagram, nodes) {
      const group = {}

      this.polygonGenerator(diagram, group, nodes)

      return group
    },
    // gets groups that are currently locked in position or that contain a node locked in position
    getFixed(diagram, otherThan) {
      let ret = diagram.groups ?? []

      if (otherThan != null) {
        ret = ret.filter(g => g.id !== otherThan)
      }
      ret = ret.filter(group => Utils.isFixed(diagram, group))

      return ret
    },
    toggle(diagram) {
      const { settings, nodes, simulations, groups } = diagram
      if (!groups) return

      settings.grouping = !settings.grouping

      nodes.forEach(node => {
        const nodePx = node.px,
              nodePy = node.py
        node.px = node.x
        node.py = node.y
        if (nodePx != null) {
          node.x = nodePx
          node.y = nodePy
        }
      })

      const pAlpha = simulations.nodes.pAlpha,
            pGroupAlpha = simulations.groups.pAlpha
      simulations.nodes.pAlpha = simulations.nodes.alpha()
      simulations.groups.pAlpha = simulations.groups.alpha()

      if (pAlpha != null) {
        simulations.nodes.alpha(pAlpha)
        simulations.groups.alpha(pGroupAlpha)
      } else {
        simulations.nodes.alpha(1)
        simulations.groups.alpha(1)
      }

      this.setup(diagram)

      if (settings.grouping) simulations.groups.alphaTarget(0).restart()
      simulations.nodes.alphaTarget(0).restart()

      Store.set(diagram, "grouping", settings.grouping.toString())
    },
    polygonGenerator({ settings }, group, nodes) {
      if(!nodes.length) return null
      let coords = nodes.reduce(
        (acc, d) => ({
          x: [Math.min(acc.x[0], d.x), Math.max(acc.x[1], d.x)],
          y: [Math.min(acc.y[0], d.y), Math.max(acc.y[1], d.y)],
        })
        ,
        { x: [nodes[0].x, nodes[0].x], y: [nodes[0].y, nodes[0].y] }
      )
      group.bounds = _.cloneDeep(coords)
      coords.x[0] -= settings.groupPadding
      coords.x[1] += settings.groupPadding
      coords.y[0] -= settings.groupPadding
      coords.y[1] += settings.groupPadding

      Object.assign(group, {
        width: coords.x[1] - coords.x[0],
        height: coords.y[1] - coords.y[0]
      })

      let polygon = group.polygon = [
        [coords.x[0], coords.y[0]],
        [coords.x[1], coords.y[0]],
        [coords.x[1], coords.y[1]],
        [coords.x[0], coords.y[1]]
      ]

      group.x = coords.x[0]
      group.y = coords.y[0]
      group.cx = group.x + group.width / 2
      group.cy = group.y + group.height / 2

      return d3.polygonHull(polygon)
    },
    move(diagram, group, nodes, xDiff, yDiff, forceLock) {
      nodes.forEach(node => {
        node.x += xDiff
        node.y += yDiff
        if (node.fx ?? forceLock) node.fx = node.x
        if (node.fy ?? forceLock) node.fy = node.y
      })
    },
    update(diagram, layer) {
      const { settings, focusedGroup } = diagram,
            { groups, graphics } = layer

      if (!settings.grouping || !groups) return

      groups.forEach(group => {
        if (group.locked) return

        const groupId = group.id
        let points = group.nodes = graphics.nodes
          .filter(d => d.group === groupId)
          .data()
        let polygon = Grouping.polygonGenerator(diagram, groups[groupId], points)

        if (!polygon) return

        if (focusedGroup === group.id) {
          graphics.groupCloseBtn
            .attr("x", group.x + group.width - 20)
            .attr("y", group.y - 10)
        }
        graphics.groupRect
          .filter(d => d === groupId)
          .attr("x", group.x)
          .attr("y", group.y)
          .attr("width", group.width)
          .attr("height", group.height)
        graphics.groupTexts
          .filter(d => d === groupId)
          .attr("x", group.x + 20)
          .attr("y", group.y + 45)
          .attr("style", "font-size: 36px; font-family: Arial, Helvetica, sans-serif")
      })
    },
    focus(diagram, groupId) {
      Grouping.unfocus(diagram)
      diagram.focusedGroup = groupId
      const group = diagram.groups[groupId]

      const rect = d3.select(diagram.currentLayer.graphics.groupRect._groups[0][groupId]);
      rect.attr('fill', 'transparent');
      
      let groupImage = diagram.currentLayer.dom.svg.selectAll('.image_' + groupId);
      groupImage.style('display', 'none')

      diagram.graphics.groupCloseBtn
        .attr("x", group.x + group.width - 20)
        .attr("y", group.y - 10)
        .attr("style", "display: block")
        .on("click", () => {
          this.unfocus(diagram, { k: 0.25 });
          groupImage.style('display', 'inline')
          rect.attr('fill', '#99d9ea');
        })

      Zoom.focusOnArea(diagram, group)
    },
    unfocus(layer, targetZoom) {
      const { focusedGroup, groups, dom, zoomBehavior, graphics } = layer

      if (focusedGroup < 0) return
      const group = groups[focusedGroup]

      if (targetZoom) {
        dom.svg
          .transition()
          .call(zoomBehavior.scaleTo, targetZoom.k)
      }
      graphics.groupCloseBtn.style("display", "none")
      group.locked = false
      layer.focusedGroup = -1
    },
    setup({ settings, graphics, simulations }) {
      if (settings.grouping) {
        graphics.groupRect.attr("display", "block")
        graphics.groupCloseBtn.attr("display", "block")
        graphics.groupTexts.attr("display", "block")
        simulations.nodes
          .force("x", d3.forceX().strength(0.1)).force("y", d3.forceY().strength(0.1))
          .force("charge", d3.forceManyBody().strength(-3000))
      } else {
        graphics.groupRect.attr("display", "none")
        graphics.groupCloseBtn.attr("display", "none")
        graphics.groupTexts.attr("display", "none")
        simulations.nodes
          .force("x", d3.forceX().strength(0.4)).force("y", d3.forceY().strength(0.4))
          .force("charge", d3.forceManyBody().strength(-5000))
        simulations.groups.stop()
      }
    },
    box({ settings }, containers) {
      let groupRects = containers.append("rect")
        .attr("class", "group-rect")
        .attr("stroke", "#83bad6")
        .attr("stroke-width", 10) 
        .attr("rx", 15)
        .attr("fill", "#99d9ea")
        .attr("opacity", 1);

        return groupRects;
    },
    closeButton(diagram, containers) {
      return containers.append("image")
        .attr("href", "assets/img/close.png")
        .attr("height", 30)
    },
    init(diagram, layer) {
      let fixedGroups = [],
          dragStart = {},
          { settings } = diagram,
          { groups, graphics, dom, simulations } = layer

      if (!groups || groups.length === 0) return

      graphics.groupContainers = dom.groupsContainer.selectAll(".group")
        .data(groups.map(({ id }) => id))
        .enter();

      graphics.groupRect = this.box(diagram, graphics.groupContainers)
        .call(d3.drag()
          .on("start", (p) => {
            if (Utils.inInteractMode() || layer.focusedGroup === p) return null
            if (!d3.event.active) {
              simulations.nodes.alphaTarget(0.7).restart()
              simulations.groups.alphaTarget(0.7).restart()
            }
            dragStart.x = d3.event.x
            dragStart.y = d3.event.y
            groups[p].sx = groups[p].x
            groups[p].sy = groups[p].y
            graphics.nodes.filter(d => d.group === p).each(d => {
              d.fx = d.sx = d.x
              d.fy = d.sy = d.y
            })
            fixedGroups = this.getFixed(diagram, p)
          })
          .on("drag", (p) => {
            if (Utils.inInteractMode() || layer.focusedGroup === p) return null
            let fx = groups[p].sx - dragStart.x + d3.event.x
            let fy = groups[p].sy - dragStart.y + d3.event.y

            graphics.nodes.filter(d => d.group === p).each(d => {
              d.fx = d.sx - dragStart.x + d3.event.x
              d.fy = d.sy - dragStart.y + d3.event.y
            })

            groups[p].fx = fx
            groups[p].fy = fy
          })
          .on("end", (p) => {
            if (Utils.inInteractMode()) return null
            let group = groups[p]

            if (!d3.event.active) {
              simulations.groups.alphaTarget(0)
              simulations.nodes.alphaTarget(0)
            }

            this.update(diagram, layer)

            if (settings.floatMode || fixedGroups.some(fg => Utils.haveIntersection(diagram, fg, group))) {
              group.fx = null
              group.fy = null
              graphics.nodes.filter(d => d.group === p).each(d => {
                d.fx = null
                d.fy = null
              })
            }
            Layout.save(diagram)
          })
        )
        .on("click", d => {
          if (d3.event.shiftKey) this.focus(diagram, d)
        })
      graphics.groupTexts = graphics.groupContainers
        .append("text")
        .text(d => groups[d].name)
        .attr("class", "group-text")
        .on("click", d => {
          if (d3.event.shiftKey) this.focus(diagram, d)
        })
        
      graphics.groupCloseBtn = this.closeButton(diagram, dom.groupsContainer)
        .attr("style", "display: none");


      this.setup(diagram);
    }
  }

  const IpAddress = {
    init(diagram, layer) {
      layer.dom.svg.selectAll('text')
        .each(function(d) {
          let isDevice = d.url && d.url.length > 0;
          if (isDevice) {
            const existingText = d3.select(this);
            const bbox = existingText.node().getBBox();

            const newX = bbox.x;
            const newY = bbox.y + bbox.height + 15; 

            let newText = d3.select(this.parentNode)
              .append('text')
              .text(d.ipAddress)
              .attr('x', newX)
              .attr('y', newY)
              .attr('font-size', '16px')
              .attr('class', 'ip-address');

            const newTextWidth = newText.node().getBBox().width;
            newText.attr('x', newX + (bbox.width - newTextWidth) / 2);
            newText.style('visibility', diagram.settings.showIpAddress ? 'visible' : 'hidden');
          }
        });
    },

    toggle(diagram) {
      const { settings } = diagram

      let layer = diagram.layers[0].dom.svg;
      settings.showIpAddress = !settings.showIpAddress;

      layer.selectAll('.ip-address')
        .style('visibility', diagram.settings.showIpAddress ? 'visible' : 'hidden');

        Store.set(diagram, "showIpAddress", settings.showIpAddress.toString())
    }
  };

  const Simulations = {
    forces: {
      cluster({ settings, groups }) {
        const strength = 0.2
        let nodes

        function force(alpha) {
          if (!settings.grouping || !groups || groups.length === 0) return
          const l = alpha * strength
          for (const d of nodes) {
            const { cx, cy } = (groups[d.group] || { cx: 0, cy: 0 })
            if (cx && cy) {
              d.vx -= (d.x - cx) * l
              d.vy -= (d.y - cy) * l
            }
          }
        }

        force.initialize = _ => nodes = _

        return force
      },
      rectCollide(diagram) {
        function constant(_) {
          return function () { return _ }
        }
        let nodes
        let size = constant([0, 0])
        let iterations = 1
        const padding = 100

        function sizes(i) {
          const n = nodes[i]
          return [n.width, n.height]
        }

        function masses(i) {
          const s = sizes(i)
          return s[0] * s[1]
        }

        function force() {
            var node, size, mass, xi, yi
            var i = -1
            while (++i < iterations) { iterate() }

            function iterate() {
                var j = -1
                var tree = d3.quadtree(nodes, xCenter, yCenter).visitAfter(prepare)

                while (++j < nodes.length) {
                    node = nodes[j]
                    size = sizes(j)
                    mass = masses(j)
                    xi = xCenter(node)
                    yi = yCenter(node)

                    tree.visit(apply)
                }
            }

            function apply(quad, x0, y0, x1, y1) {
                var data = quad.data
                var xSize = ((size[0] + quad.size[0]) / 2) + padding
                var ySize = ((size[1] + quad.size[1]) / 2) + padding
                let strength = 1
                if (data) {
                    if (data.index <= node.index) { return }

                    var x = xi - xCenter(data)
                    var y = yi - yCenter(data)
                    var xd = Math.abs(x) - xSize
                    var yd = Math.abs(y) - ySize

                    if (xd < 0 && yd < 0) {
                        var l = Math.sqrt(x * x + y * y)
                        var m = masses(data.index) / (mass + masses(data.index))

                        if (Math.abs(xd) < Math.abs(yd)) {
                            let xDiff = (x *= xd / l * strength) * m
                            if (!Utils.isFixed(diagram, node)) {
                              node.nodes.forEach(n => {
                                n.x -= xDiff
                              })
                            }
                            if (!Utils.isFixed(diagram, data)) {
                              data.nodes.forEach(n => {
                                n.x += x * (1 - m)
                              })
                            }
                        } else {
                            let yDiff = (y *= yd / l * strength) * m
                            if (!Utils.isFixed(diagram, node)) {
                              node.nodes.forEach(n => {
                                n.y -= yDiff
                              })
                            }
                            if (!Utils.isFixed(diagram, data)) {
                              data.nodes.forEach(n => {
                                n.y += y * (1 - m)
                              })
                            }
                        }
                    }
                }

                let collide = x0 > xi + xSize || y0 > yi + ySize ||
                      x1 < xi - xSize || y1 < yi - ySize

                return collide
            }

            function prepare(quad) {
                if (quad.data) {
                    quad.size = sizes(quad.data.index)
                } else {
                    quad.size = [0, 0]
                    var i = -1
                    while (++i < 4) {
                        if (quad[i] && quad[i].size) {
                            quad.size[0] = Math.max(quad.size[0], quad[i].size[0])
                            quad.size[1] = Math.max(quad.size[1], quad[i].size[1])
                        }
                    }
                }
            }
        }

        function xCenter(d) { return d.x + d.vx + sizes(d.index)[0] / 2 }
        function yCenter(d) { return d.y + d.vy + sizes(d.index)[1] / 2 }

        force.initialize = function (_) {
          nodes = _
        }

        force.size = function (_) {
            return (arguments.length
                ? (size = typeof _ === "function" ? _ : constant(_), force)
                : size)
        }

        force.strength = function (_) {
            return (arguments.length ? (strength = +_, force) : strength)
        }

        force.iterations = function (_) {
            return (arguments.length ? (iterations = +_, force) : iterations)
        }

        return force
      }
    },
    nodes: {
      create(diagram, layer) {
        const { settings } = diagram,
              { nodes, edges, groups } = layer

        const simulation = d3.forceSimulation()
          .nodes(nodes)
          .force("x", d3.forceX().strength(0.1)).force("y", d3.forceY().strength(0.1))
          .force("link", d3.forceLink(edges).id(d => d.name).strength(link => {
            // when not grouping, links should be stronger
            if (!settings.grouping || !groups || groups.length === 0) {
              return 1
              // when grouping, we differentiate between same and not same group links
            } else if (link.source.group === link.target.group) {
              return 0.3
            } else {
              return 0.09
            }
          }))
          .force("cluster", Simulations.forces.cluster(diagram))
          .force("charge", d3.forceManyBody().strength(-3000))
          .alpha(1)
          .alphaTarget(0)
          .on("tick", function() {
            Graphics.update(layer);
          });

        return simulation;
      },
    },
    groups: {
      create(diagram, layer) {
        const { groups } = layer

        return d3.forceSimulation()
          .alpha(1)
          .alphaTarget(0)
          .force("collision", Simulations.forces.rectCollide(diagram))
          .nodes(groups)
          .on("tick", () => {
            Grouping.update(diagram, layer)
          })
      }
    },
    drag(diagram, layer) {
      let bounds,
          fixedGroups = []

      function dragstarted(d) {
        const { simulations, settings, focusedGroup, groups } = diagram
        if (Utils.inInteractMode()) return null

        if (!d3.event.active) {
          simulations.nodes.alphaTarget(0.7).restart()
          if (settings.grouping && simulations.groups) {
            simulations.groups.alphaTarget(0.7).restart()
          }
        }

        d.fx = d.x
        d.fy = d.y

        if (focusedGroup > -1) {
          groups[focusedGroup].locked = true
          bounds = groups[focusedGroup]
          bounds = {
            x: [bounds.x + settings.groupPadding, bounds.x + bounds.width - settings.groupPadding],
            y: [bounds.y + settings.groupPadding, bounds.y + bounds.height - settings.groupPadding]
          }
        } else {
          bounds = null
        }

        fixedGroups = Grouping.getFixed(diagram, d.group)
      }

      function dragged(d) {
        if (Utils.inInteractMode()) return null
        if (!bounds || (d3.event.x > bounds.x[0] && d3.event.x < bounds.x[1])) d.fx = d3.event.x
        if (!bounds || (d3.event.y > bounds.y[0] && d3.event.y < bounds.y[1])) d.fy = d3.event.y
      }

      function dragended(d) {
        if (Utils.inInteractMode()) return null
        const { groups, simulations, settings } = diagram,
              group = groups ? groups[d.group] : null

        if (!d3.event.active) {
          if (simulations.groups) simulations.groups.alphaTarget(0)
          simulations.nodes.alphaTarget(0)
        }

        if (groups) Grouping.update(diagram, layer)

        if (settings.floatMode || fixedGroups.some(fg => Utils.haveIntersection(diagram, fg, group))) {
          d.fx = null
          d.fy = null
        }
        Layout.save(diagram)
      }

      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended)
    },
    init(diagram) {
      const layer = diagram.layers[0]

      layer.simulations = {
        nodes: Simulations.nodes.create(diagram, layer)
      }
      if (layer.groups && layer.groups.length > 0)
        layer.simulations.groups = Simulations.groups.create(diagram, layer)
    },
    teardown({ simulations }) {
      Object.keys(simulations).forEach(key => {
        simulations[key].stop()
        delete simulations[key]
      })
    },
    stop({ simulations }) {
      if (simulations) Object.values(simulations).forEach(simulation => simulation.stop())
    }
  }

  const Graphics = {
    getLinkWidth(w) {
      return [
        [10000000, 3],
        [100000000, 4],
        [1000000000, 5],
        [10000000000, 6],
        [25000000000, 7],
        [50000000000, 8],
        [100000000000, 9],
        [Infinity, 10]
      ].find(([limit]) => w < limit)[1]
    },
    update({ focusedGroup, groups, graphics }) {
      if (groups && focusedGroup > -1) {
        const group = groups[focusedGroup]
        group.nodes.forEach(d => {
          if (d.x < group.bounds.x[0]) {
            d.x = group.bounds.x[0]
          } else if (d.x > group.bounds.x[1]) {
            d.x = group.bounds.x[1]
          }
          if (d.y < group.bounds.y[0]) {
            d.y = group.bounds.y[0]
          } else if (d.y > group.bounds.y[1]) {
            d.y = group.bounds.y[1]
          }
        })
      }

      graphics.links
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y)
      graphics.nodes.attr("transform", d => `translate(${d.x}, ${d.y})`)

      graphics.groupRect._groups[0].forEach(function (d, index) {
        let rectBBox = d.getBBox();
        let rectX = rectBBox.x + rectBBox.width / 2;
        let rectY = rectBBox.y + rectBBox.height / 2;
        let parentContainer = d3.select(d.parentNode);
        let image = 'image_' + index
        parentContainer.selectAll('.' + image).remove();

        parentContainer
          .append('image')
          .attr("class", image)
          .attr("xlink:href", 'assets/Graphics/group.png')
          .attr("x", rectX - 50) 
          .attr("y", rectY - 50)
          .attr("width", 92)
          .attr("height", 92);
      });
    },
    create(diagram, layer) {
      const graphics = diagram.graphics = {}
      const { dom, edges, nodes, settings } = diagram

        /**
         * @function showTooltipAt
         * @param {string} target=('target'|'coords')
         * @param {Event} event
         * @returns void
         */
      const showTooltipAt = _.throttle((target, event) => {
          const containerOffset = dom.container.node().getBoundingClientRect()
          let left = -containerOffset.left
          let top = 0
          if (target === 'target') {
              const pos = event.target.getBoundingClientRect()
              left += pos.left + pos.width
              top += pos.top
          }
          if (target === 'coords') {
              left += event.pageX + 10
              top += event.pageY
          }
          top += settings.toolbar ? -10 : 10
          dom.tooltipDiv.style('left', `${left}px`).style('top', `${top}px`)
      }, 50, { trailing: false })

      //controls all link drawing and formatting
      graphics.links = layer.dom.layerContainer.selectAll("line")
        .data(edges)
        .enter().append("line")
        .attr("stroke", d => {
          if (d.isStaticWan) {
            return "black"
          } else if (d.warning) {
            return "red"
          } else {
            return "green"
          }
        })
        .attr("stroke-width", d => {
          return d.isStaticWan ? 5 : Graphics.getLinkWidth(d.bandwidth)
        })
        .on("mouseover", d => {
            if (d.QoS || !d.isStaticWan) {
                dom.tooltipDiv.transition()
                    .duration(200)
                    .style('opacity', .9)
                    .style('display', 'block')

                const parts = [d.intDescription, d.ipAddress, (d.mask ?? d.target.mask), Data.downScaleBandwidth(d.bandwidth)]
                if (d.QoS) parts.push(d.QoS)
                dom.tooltipDiv.html(parts.join('<br>'))
                showTooltipAt('coords', d3.event)
            }
        })
        .on("mouseout", () => {
          dom.tooltipDiv.transition()
            .duration(200)
            .style("opacity", 0)
            .style("display", "none")
        })
        .on("click", d => {
          //only clickable if in interactive mode
          if (Utils.inInteractMode()) window.location.assign(d.url)
        })

      // controls all node drawing and formatting
      graphics.nodes = layer.dom.layerContainer.selectAll(".node")
        .data(nodes)
        .enter().append("g")
        .attr('class', 'tes')
        .on("mouseover", function(d) {
          // only show tooltips for the current layer
          const parts = []


          dom.tooltipDiv.transition()
            .duration(200)
            .style("opacity", .9)
            .style("display", "block")

          if (d.isUnmanaged) {
              parts.push(d.name)
          } else if (d.isCloud) {
              parts.push(`Subnet: ${d.subnet}`, `Mask: ${d.mask}`)
          } else {
            if (d.manufacturer || d.model || d.softwareOS) {
                parts.push(d.ipAddress, d.manufacturer, d.model, d.softwareOS, d.location)
            } else {
                parts.push('n/a')
            }
          }
          dom.tooltipDiv.html(parts.join('<br>'))
          showTooltipAt('target', d3.event)
        })
        .on("mouseout", function(d) {
          dom.tooltipDiv.transition()
            .duration(200)
            .style("opacity", 0)
            .style("display", "none")

          if (d.isCloud) {
            d3.select(this).select("circle").transition().attr("r", 0)
          }
        })
        .on("click", d => {
          if (Utils.inInteractMode()) Layers.drillDown.do(diagram, d)
        })
        .call(Simulations.drag(diagram, layer))
        
      graphics.nodes.append("circle")
        .attr("r", 0)
        .attr("stroke", "grey")
        .attr("stroke-width", "1px")
        .attr("fill", "#eee")
        .style('display', 'none')

      //attach image to node
      graphics.nodes.append("image")
        .attr("xlink:href", d => d.image)
        .attr("height", d => {
          const h = 60
          return d.isCloud ? (h * 1.5) : h
        })
        .attr("width", d => {
          const w = 60
          return d.isCloud ? (w * 1.5) : w
        })
        .attr("x", d => {
          const x = -30
          return d.isCloud ? (x * 1.5) : x
        })
        .attr("y", d => {
          const y = -30
          return d.isCloud ? (y * 1.5) : y
        })

      //controls the labels for each node
      graphics.nodes.append("text")
        .style("font-size", d => d.isCloud ? "13px" : "16px")
        .style("fill", "black")
        .style("font-family", "Arial, Helvetica, sans-serif")
        .attr("text-anchor", "middle")
        .attr("dy", d => {
          const dy = 45
          return d.isCloud ? (dy * 0.1) : dy
        })
        .text(d => {
          if (d.isUnmanaged) {
            return ""
          } else if (d.isCloud) {
            if (!d.isPrivate && Data.onlyHasOneDev(diagram, d.subnet)) {
              return "Internet"
            }
            return d.subnet
          } else {
            return d.name
          }
        })
    }
  }

  const Data = {
    // control output for bandwidth
    downScaleBandwidth(val) {
      return [
        [100000000000, "100gig"],
        [50000000000, "50gig"],
        [40000000000, "40gig"],
        [25000000000, "25gig"],
        [20000000000, "20gig"],
        [10000000000, "10gig"],
        [1000000000, "1gig"],
        [100000000, "100meg"],
        [10000000, "10meg"],
        [0, `${val}bits`]
      ].find(([limit]) => val >= limit)[1]
    },
    inPubInt(subnet) {
      let splitSubnet = subnet.split(".")

      switch(splitSubnet[0]) {
        case "10":
          return false
        case "169":
          return splitSubnet[1] === "254" ? false : true
        case "172":
          return (parseInt(splitSubnet[1]) > 15 && parseInt(splitSubnet[1]) < 32) ? false : true
        case "192":
          return splitSubnet[1] === "168" ? false : true
        default:
          return true
      }
    },
    onlyHasOneDev({ edges }, sub) {
      let count = 0

      for (const edge of edges) {
        if (edge.target === "Cloud-" + sub) count++
      }

      if (count > 1) {
        // normal cloud, do nothing different
        return false
      }

      return true
    },
    process(layer, graph) {
      const { autocompleteItems } = layer

      if (!graph.subnets) graph.subnets = []
      graph.subnets.forEach(sub => {
        sub.isCloud = true
        // for clouds, take subnet instead of name unless WAN cloud
        if (sub.isUnmanaged) {
          autocompleteItems.push(sub.name)
        } else {
          autocompleteItems.push(sub.subnet)
        }
      })
      graph.devices.forEach(node => autocompleteItems.push(node.name))

      // nodes = devices + subnets
      const nodes = layer.nodes = graph.devices.concat(graph.subnets),
            edges = layer.edges = graph.links,
            groups = layer.groups = graph.groups?.map((name, i) => ({ id: i, name }))

      edges.forEach(edge => {
        const source = _.find(nodes, d => d.name === edge.source),
              target = _.find(nodes, d => d.name === edge.target)

        if (source) edge.source = source
        if (target) edge.target = target

        if (groups) {
          if (
            source.hasOwnProperty("group") &&
            !target.hasOwnProperty("group")
          ) {
            target.group = source.group
          } else if (
            source.hasOwnProperty("group") &&
            target.hasOwnProperty("group") &&
            source.group !== target.group
          ) {
            if (source.isCloud) delete source.group
            if (target.isCloud) delete target.group
          }
        }

        edge.width = edge.isStaticWan ? 5 : Graphics.getLinkWidth(edge.bandwidth)
      })
    },
    fetch(url) {
      let data = {
        "devices": [
            {
                "DevNum": 0,
                "group": 0,
                "image": "assets/Graphics/Firewall.png",
                "ipAddress": "10.86.0.4",
                "location": "",
                "manufacturer": "Cisco Meraki",
                "model": "MX65",
                "name": "hqmx65",
                "softwareOS": "",
                "url": "Devices.html?d=0"
            },
            {
                "DevNum": 1,
                "group": 0,
                "image": "assets/Graphics/Firewall.png",
                "ipAddress": "10.86.0.5",
                "location": "santa clara",
                "manufacturer": "Palo Alto Networks",
                "model": "PA-450",
                "name": "hqpa450",
                "softwareOS": "10.2.7",
                "url": "Devices.html?d=1"
            },
            {
                "DevNum": 2,
                "group": 0,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.0.0.46",
                "location": "Santa Clara, CA",
                "manufacturer": "Fortinet",
                "model": "FGT_140D_POE",
                "name": "hqf140d-poe",
                "softwareOS": "FortiGate-140D-POE v6.2.14,build1364,230411 (GA)",
                "url": "Devices.html?d=2"
            },
            {
                "DevNum": 3,
                "group": 1,
                "image": "assets/Graphics/Firewall.png",
                "ipAddress": "10.200.10.9",
                "location": "Santa Clara, CA",
                "manufacturer": "OpenGear, Inc",
                "model": "",
                "name": "SV-LAB-OPENGEAR",
                "softwareOS": "",
                "url": "Devices.html?d=3"
            },
            {
                "DevNum": 7,
                "group": 1,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.200.10.50",
                "location": "",
                "manufacturer": "Cisco Systems Inc",
                "model": "C9800-CL-K9",
                "name": "LAB-C9800-CL",
                "softwareOS": "",
                "url": "Devices.html?d=7"
            },
            {
                "DevNum": 8,
                "group": 1,
                "image": "assets/Graphics/MultilayerSwitch.png",
                "ipAddress": "10.200.10.254",
                "location": "",
                "manufacturer": "Cisco Systems, Inc",
                "model": "",
                "name": "SV1-SW-01",
                "softwareOS": "",
                "url": "Devices.html?d=8"
            },
            {
                "DevNum": 9,
                "group": 2,
                "image": "assets/Graphics/MultilayerSwitch.png",
                "ipAddress": "10.0.0.1",
                "location": "Santa Clara",
                "manufacturer": "Cisco Systems, Inc",
                "model": "WS-C3650-24PS-E",
                "name": "Syrah",
                "softwareOS": "Denali 16.3.5b",
                "url": "Devices.html?d=9"
            },
            {
                "DevNum": 10,
                "group": 2,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.0.0.2",
                "location": "\"Santa Clara\"",
                "manufacturer": "Cisco",
                "model": "CISCO2811",
                "name": "SantaClara",
                "softwareOS": "15.1(1)T",
                "url": "Devices.html?d=10"
            },
            {
                "DevNum": 12,
                "group": 2,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.0.0.7",
                "location": "Santa Clara",
                "manufacturer": "Cisco Systems Inc",
                "model": "ASR1001",
                "name": "tempranillo",
                "softwareOS": "",
                "url": "Devices.html?d=12"
            },
            {
                "DevNum": 13,
                "group": 2,
                "image": "assets/Graphics/MultilayerSwitch.png",
                "ipAddress": "10.0.0.12",
                "location": "Santa Clara",
                "manufacturer": "Cisco Systems, Inc.",
                "model": "N9K-C9372TX",
                "name": "Michelob",
                "softwareOS": "",
                "url": "Devices.html?d=13"
            },
            {
                "DevNum": 25,
                "group": 2,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.0.0.39",
                "location": "Santa Clara",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "Alsace",
                "softwareOS": "15.1(3)T3",
                "url": "Devices.html?d=25"
            },
            {
                "DevNum": 34,
                "group": 3,
                "image": "assets/Graphics/Server.png",
                "ipAddress": "10.1.0.27",
                "location": "Santa Clara",
                "manufacturer": "VMware, Inc.",
                "model": "",
                "name": "dev-rhel85-01",
                "softwareOS": "",
                "url": "Devices.html?d=34"
            },
            {
                "DevNum": 35,
                "group": 4,
                "image": "assets/Graphics/Firewall.png",
                "ipAddress": "10.51.0.1",
                "location": "Round Rock, TX",
                "manufacturer": "Palo Alto Networks",
                "model": "PA-440",
                "name": "txfw1",
                "softwareOS": "10.2.6",
                "url": "Devices.html?d=35"
            },
            {
                "DevNum": 42,
                "group": 4,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.51.0.254",
                "location": "Round Rock TX",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "AustinRTR",
                "softwareOS": "15.1(4)M9",
                "url": "Devices.html?d=42"
            },
            {
                "DevNum": 43,
                "group": 5,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.51.20.1",
                "location": "Round Rock TX",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "DallasRtR",
                "softwareOS": "15.1(4)M9",
                "url": "Devices.html?d=43"
            },
            {
                "DevNum": 45,
                "group": 5,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.51.30.1",
                "location": "Round Rock TX",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "HoustonRtR",
                "softwareOS": "15.1(4)M9",
                "url": "Devices.html?d=45"
            },
            {
                "DevNum": 47,
                "group": 6,
                "image": "assets/Graphics/MultilayerSwitch.png",
                "ipAddress": "10.30.0.1",
                "location": "Santa Clara CA",
                "manufacturer": "Extreme Networks",
                "model": "800470-00-11",
                "name": "bostonsw1-stout",
                "softwareOS": "",
                "url": "Devices.html?d=47"
            },
            {
                "DevNum": 48,
                "group": 6,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.30.0.2",
                "location": "\"Santa Clara\"",
                "manufacturer": "Cisco",
                "model": "CISCO2811      ",
                "name": "Boston",
                "softwareOS": "",
                "url": "Devices.html?d=48"
            },
            {
                "DevNum": 50,
                "group": 7,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.50.0.2",
                "location": "Sunnyvale, CA",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "Sunnyvale",
                "softwareOS": "15.0(1)M10",
                "url": "Devices.html?d=50"
            },
            {
                "DevNum": 59,
                "group": 7,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.50.4.1",
                "location": "Atlanta, GA",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "Pacifica",
                "softwareOS": "15.1(3)T3",
                "url": "Devices.html?d=59"
            },
            {
                "DevNum": 62,
                "group": 8,
                "image": "assets/Graphics/Router.png",
                "ipAddress": "10.60.0.1",
                "location": "",
                "manufacturer": "Cisco",
                "model": "CISCO1841",
                "name": "Chicago",
                "softwareOS": "15.1(3)T3",
                "url": "Devices.html?d=62"
            }
        ],
        "groups": [
            "Headquarters-Firewall",
            "Headquarters-DMZ",
            "Headquarters",
            "Headquarters-VMware",
            "Austin",
            "Austin Lab",
            "Boston",
            "Sunnyvale",
            "WAN"
        ],
        "links": [
            {
                "DevNum": 0,
                "LastChanged": "0 days 00:00:00.00",
                "MTU": 0,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "Single VLAN Virtual Interface",
                "intNum": 0,
                "ipAddress": "10.86.0.4",
                "receive": 0.0,
                "source": "hqmx65",
                "target": "Cloud-10.86.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=0&i=0",
                "warning": 0
            },
            {
                "DevNum": 1,
                "LastChanged": "0 days 14:59:30.31",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "mgmt: mgmt",
                "intNum": 5,
                "ipAddress": "10.0.0.251",
                "receive": 0.0,
                "source": "hqpa450",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=1&i=5",
                "warning": 0
            },
            {
                "DevNum": 1,
                "LastChanged": "0 days 14:59:30.31",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "ethernet1/1: ethernet1/1 (Internet (AT&T))",
                "intNum": 6,
                "ipAddress": "104.8.32.109",
                "receive": 0.0,
                "source": "hqpa450",
                "target": "Cloud-104.8.32.104",
                "transmit": 0.0,
                "url": "Devices.html?d=1&i=6",
                "warning": 0
            },
            {
                "DevNum": 1,
                "LastChanged": "0 days 14:59:30.31",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "ethernet1/2: ethernet1/2 (Inside (Transit Network))",
                "intNum": 7,
                "ipAddress": "10.86.0.5",
                "receive": 0.0,
                "source": "hqpa450",
                "target": "Cloud-10.86.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=1&i=7",
                "warning": 0
            },
            {
                "DevNum": 1,
                "LastChanged": "0 days 14:59:30.31",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "ethernet1/3: ethernet1/3 (DMZ to Lab Gear)",
                "intNum": 8,
                "ipAddress": "10.199.0.1",
                "receive": 0.0,
                "source": "hqpa450",
                "target": "Cloud-10.199.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=1&i=8",
                "warning": 0
            },
            {
                "DevNum": 1,
                "LastChanged": "0 days 14:59:30.31",
                "MTU": 0,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "tunnel.1: tunnel.1 (Tunnel to TX)",
                "intNum": 400000001,
                "ipAddress": "10.142.0.1",
                "receive": 0.0,
                "source": "hqpa450",
                "target": "Cloud-10.142.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=1&i=400000001",
                "warning": 0
            },
            {
                "DevNum": 2,
                "LastChanged": "105 days 10:44:09.44",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "lan: ",
                "intNum": 1,
                "ipAddress": "192.168.100.99",
                "receive": 0.0,
                "source": "hqf140d-poe",
                "target": "Cloud-192.168.100.0",
                "transmit": 0.0,
                "url": "Devices.html?d=2&i=1",
                "warning": 0
            },
            {
                "DevNum": 2,
                "LastChanged": "105 days 10:44:09.44",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "mgmt: ",
                "intNum": 8,
                "ipAddress": "10.0.0.46",
                "receive": 0.0,
                "source": "hqf140d-poe",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=2&i=8",
                "warning": 0
            },
            {
                "DevNum": 3,
                "LastChanged": "0 days 00:00:00.00",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "eth0: eth0",
                "intNum": 2,
                "ipAddress": "10.200.99.9",
                "receive": 0.0,
                "source": "SV-LAB-OPENGEAR",
                "target": "Cloud-10.200.99.0",
                "transmit": 0.0,
                "url": "Devices.html?d=3&i=2",
                "warning": 0
            },
            {
                "DevNum": 3,
                "LastChanged": "122 days 06:01:32.37",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "eth2: eth2",
                "intNum": 6,
                "ipAddress": "10.200.10.9",
                "receive": 0.0,
                "source": "SV-LAB-OPENGEAR",
                "target": "Cloud-10.200.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=3&i=6",
                "warning": 0
            },
            {
                "DevNum": 3,
                "LastChanged": "0 days 01:49:40.15",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "wwan0: wwan0",
                "intNum": 7,
                "ipAddress": "100.65.66.1",
                "receive": 0.0,
                "source": "SV-LAB-OPENGEAR",
                "target": "Cloud-100.65.66.0",
                "transmit": 0.0,
                "url": "Devices.html?d=3&i=7",
                "warning": 0
            },
            {
                "DevNum": 7,
                "LastChanged": "367 days 07:06:46.87",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Gi1: GigabitEthernet1",
                "intNum": 1,
                "ipAddress": "10.200.10.50",
                "receive": 0.0,
                "source": "LAB-C9800-CL",
                "target": "Cloud-10.200.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=7&i=1",
                "warning": 0
            },
            {
                "DevNum": 7,
                "LastChanged": "367 days 07:06:43.90",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl123: Vlan123",
                "intNum": 6,
                "ipAddress": "10.200.123.50",
                "receive": 0.0,
                "source": "LAB-C9800-CL",
                "target": "Cloud-10.200.123.0",
                "transmit": 0.0,
                "url": "Devices.html?d=7&i=6",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 06:24:21.54",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa1: FastEthernet1",
                "intNum": 1,
                "ipAddress": "10.200.10.2",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=1",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 06:48:36.58",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl10: Vlan10",
                "intNum": 61,
                "ipAddress": "10.200.10.254",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=61",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 06:47:57.57",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl20: Vlan20",
                "intNum": 62,
                "ipAddress": "10.200.20.254",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.20.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=62",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 06:47:57.57",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl30: Vlan30",
                "intNum": 63,
                "ipAddress": "10.200.30.254",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.30.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=63",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 12:02:38.54",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl99: Vlan99",
                "intNum": 64,
                "ipAddress": "10.200.99.254",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.99.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=64",
                "warning": 0
            },
            {
                "DevNum": 8,
                "LastChanged": "367 days 06:47:57.57",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl123: Vlan123",
                "intNum": 65,
                "ipAddress": "10.200.123.254",
                "receive": 0.0,
                "source": "SV1-SW-01",
                "target": "Cloud-10.200.123.0",
                "transmit": 0.0,
                "url": "Devices.html?d=8&i=65",
                "warning": 0
            },
            {
                "DevNum": 9,
                "LastChanged": "104 days 14:43:42.81",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl1: Vlan1 (HQ-Data)",
                "intNum": 34,
                "ipAddress": "10.0.0.1",
                "receive": 0.0,
                "source": "Syrah",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=9&i=34",
                "warning": 0
            },
            {
                "DevNum": 9,
                "LastChanged": "104 days 14:43:34.66",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl101: Vlan101 (HQ-VMware)",
                "intNum": 51,
                "ipAddress": "10.1.0.1",
                "receive": 0.0,
                "source": "Syrah",
                "target": "Cloud-10.1.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=9&i=51",
                "warning": 0
            },
            {
                "DevNum": 9,
                "LastChanged": "104 days 14:43:42.82",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl110: Vlan110 (HQ-Voice)",
                "intNum": 52,
                "ipAddress": "10.10.0.1",
                "receive": 0.0,
                "source": "Syrah",
                "target": "Cloud-10.10.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=9&i=52",
                "warning": 0
            },
            {
                "DevNum": 9,
                "LastChanged": "104 days 14:43:42.86",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl186: Vlan186 (HQ-FW-Transit)",
                "intNum": 54,
                "ipAddress": "10.86.0.1",
                "receive": 0.0,
                "source": "Syrah",
                "target": "Cloud-10.86.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=9&i=54",
                "warning": 0
            },
            {
                "DevNum": 9,
                "LastChanged": "104 days 14:43:34.65",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vl710: Vlan710 (Cisco Call Manager VLAN)",
                "intNum": 55,
                "ipAddress": "172.17.10.1",
                "receive": 0.0,
                "source": "Syrah",
                "target": "Cloud-172.17.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=9&i=55",
                "warning": 0
            },
            {
                "DevNum": 10,
                "LastChanged": "104 days 14:49:55.25",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/0/0: Serial0/0/0",
                "intNum": 1,
                "ipAddress": "192.168.10.1",
                "receive": 0.0,
                "source": "SantaClara",
                "target": "Cloud-192.168.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=10&i=1",
                "warning": 0
            },
            {
                "DevNum": 10,
                "LastChanged": "104 days 14:46:50.56",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.15349194167306215,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.0.0.2",
                "receive": 0.0,
                "source": "SantaClara",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=10&i=2",
                "warning": 0
            },
            {
                "DevNum": 12,
                "LastChanged": "7 days 22:38:40.64",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Gi0/0/0: GigabitEthernet0/0/0",
                "intNum": 1,
                "ipAddress": "10.0.0.7",
                "receive": 0.0,
                "source": "tempranillo",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=12&i=1",
                "warning": 0
            },
            {
                "DevNum": 12,
                "LastChanged": "104 days 14:37:41.63",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Gi0/0/2.30: GigabitEthernet0/0/2.30 (ASR 30 Net)",
                "intNum": 8,
                "ipAddress": "10.10.30.2",
                "receive": 0.0,
                "source": "tempranillo",
                "target": "Cloud-10.10.30.0",
                "transmit": 0.0,
                "url": "Devices.html?d=12&i=8",
                "warning": 0
            },
            {
                "DevNum": 12,
                "LastChanged": "104 days 14:37:41.63",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Gi0/0/2.40: GigabitEthernet0/0/2.40 (ASR 40 Net)",
                "intNum": 9,
                "ipAddress": "10.10.40.2",
                "receive": 0.0,
                "source": "tempranillo",
                "target": "Cloud-10.10.40.0",
                "transmit": 0.0,
                "url": "Devices.html?d=12&i=9",
                "warning": 0
            },
            {
                "DevNum": 12,
                "LastChanged": "104 days 14:37:41.63",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Gi0/0/2.50: GigabitEthernet0/0/2.50 (ASR 50 Net)",
                "intNum": 10,
                "ipAddress": "10.10.50.2",
                "receive": 0.0,
                "source": "tempranillo",
                "target": "Cloud-10.10.50.0",
                "transmit": 0.0,
                "url": "Devices.html?d=12&i=10",
                "warning": 0
            },
            {
                "DevNum": 13,
                "LastChanged": "131 days 13:50:47.70",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vlan1: Vlan1 (HQ-Data)",
                "intNum": 151060481,
                "ipAddress": "10.0.0.12",
                "receive": 0.0,
                "source": "Michelob",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=13&i=151060481",
                "warning": 0
            },
            {
                "DevNum": 13,
                "LastChanged": "145 days 12:33:50.37",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "Vlan101: Vlan101 (HQ-VMware)",
                "intNum": 151060581,
                "ipAddress": "10.1.0.2",
                "receive": 0.0,
                "source": "Michelob",
                "target": "Cloud-10.1.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=13&i=151060581",
                "warning": 0
            },
            {
                "DevNum": 25,
                "LastChanged": "104 days 14:58:42.22",
                "MTU": 1500,
                "QoS": "WFQ",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/0/0: Serial0/0/0",
                "intNum": 1,
                "ipAddress": "192.168.60.1",
                "receive": 0.0,
                "source": "Alsace",
                "target": "Cloud-192.168.60.0",
                "transmit": 0.0,
                "url": "Devices.html?d=25&i=1",
                "warning": 0
            },
            {
                "DevNum": 25,
                "LastChanged": "102 days 11:59:22.64",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.0.0.39",
                "receive": 0.0,
                "source": "Alsace",
                "target": "Cloud-10.0.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=25&i=2",
                "warning": 0
            },
            {
                "DevNum": 34,
                "LastChanged": "123 days 07:37:23.85",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 10000000000,
                "errors": 3.3135509396636995,
                "intDescription": "ens192: ens192",
                "intNum": 2,
                "ipAddress": "10.1.0.27",
                "receive": 0.0,
                "source": "dev-rhel85-01",
                "target": "Cloud-10.1.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=34&i=2",
                "warning": 0
            },
            {
                "DevNum": 35,
                "LastChanged": "0 days 10:11:01.08",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "mgmt: mgmt",
                "intNum": 5,
                "ipAddress": "10.51.0.250",
                "receive": 0.0,
                "source": "txfw1",
                "target": "Cloud-10.51.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=35&i=5",
                "warning": 0
            },
            {
                "DevNum": 35,
                "LastChanged": "0 days 10:11:01.08",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "ethernet1/1: ethernet1/1 (AT&T GigaFiber)",
                "intNum": 6,
                "ipAddress": "99.145.205.148",
                "receive": 0.0,
                "source": "txfw1",
                "target": "Cloud-99.145.204.0",
                "transmit": 0.0,
                "url": "Devices.html?d=35&i=6",
                "warning": 0
            },
            {
                "DevNum": 35,
                "LastChanged": "0 days 10:11:01.08",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 1000000000,
                "errors": 0.0,
                "intDescription": "ethernet1/2: ethernet1/2 (Inside LAN)",
                "intNum": 7,
                "ipAddress": "10.51.0.1",
                "receive": 0.0,
                "source": "txfw1",
                "target": "Cloud-10.51.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=35&i=7",
                "warning": 0
            },
            {
                "DevNum": 35,
                "LastChanged": "0 days 10:11:01.08",
                "MTU": 0,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "tunnel.1: tunnel.1 (Tunnel to HQ)",
                "intNum": 400000001,
                "ipAddress": "10.142.0.2",
                "receive": 0.0,
                "source": "txfw1",
                "target": "Cloud-10.142.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=35&i=400000001",
                "warning": 0
            },
            {
                "DevNum": 42,
                "LastChanged": "200 days 07:23:36.25",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/1/0: Serial0/1/0",
                "intNum": 1,
                "ipAddress": "10.51.250.1",
                "receive": 0.0,
                "source": "AustinRTR",
                "target": "Cloud-10.51.250.0",
                "transmit": 0.0,
                "url": "Devices.html?d=42&i=1",
                "warning": 0
            },
            {
                "DevNum": 42,
                "LastChanged": "33 days 12:55:14.78",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.51.0.254",
                "receive": 0.0,
                "source": "AustinRTR",
                "target": "Cloud-10.51.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=42&i=2",
                "warning": 0
            },
            {
                "DevNum": 43,
                "LastChanged": "200 days 07:21:09.44",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/1/0: Serial0/1/0 (WAN link to Austin)",
                "intNum": 1,
                "ipAddress": "10.51.250.2",
                "receive": 0.0,
                "source": "DallasRtR",
                "target": "Cloud-10.51.250.0",
                "transmit": 0.0,
                "url": "Devices.html?d=43&i=1",
                "warning": 0
            },
            {
                "DevNum": 43,
                "LastChanged": "200 days 07:20:55.88",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.51.20.1",
                "receive": 0.0,
                "source": "DallasRtR",
                "target": "Cloud-10.51.20.0",
                "transmit": 0.0,
                "url": "Devices.html?d=43&i=2",
                "warning": 0
            },
            {
                "DevNum": 43,
                "LastChanged": "200 days 07:21:09.44",
                "MTU": 1500,
                "QoS": "WFQ",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/0/0:0: Serial0/0/0:0 (WAN link to Houston)",
                "intNum": 7,
                "ipAddress": "10.51.251.1",
                "receive": 0.0,
                "source": "DallasRtR",
                "target": "Cloud-10.51.251.0",
                "transmit": 0.0,
                "url": "Devices.html?d=43&i=7",
                "warning": 0
            },
            {
                "DevNum": 45,
                "LastChanged": "200 days 07:23:09.87",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/1/0: Serial0/1/0",
                "intNum": 2,
                "ipAddress": "10.51.251.2",
                "receive": 0.0,
                "source": "HoustonRtR",
                "target": "Cloud-10.51.251.0",
                "transmit": 0.0,
                "url": "Devices.html?d=45&i=2",
                "warning": 0
            },
            {
                "DevNum": 45,
                "LastChanged": "200 days 07:25:50.06",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 3,
                "ipAddress": "10.51.30.1",
                "receive": 0.0,
                "source": "HoustonRtR",
                "target": "Cloud-10.51.30.0",
                "transmit": 0.0,
                "url": "Devices.html?d=45&i=3",
                "warning": 0
            },
            {
                "DevNum": 47,
                "LastChanged": "104 days 14:50:06.00",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "rtif(10.30.0.1/24): rtif(10.30.0.1/24)",
                "intNum": 1000009,
                "ipAddress": "10.30.0.1",
                "receive": 0.0,
                "source": "bostonsw1-stout",
                "target": "Cloud-10.30.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=47&i=1000009",
                "warning": 0
            },
            {
                "DevNum": 47,
                "LastChanged": "104 days 14:50:06.00",
                "MTU": 1500,
                "QoS": "",
                "bandwidth": 0,
                "errors": 0.0,
                "intDescription": "rtif(10.30.10.1/24): rtif(10.30.10.1/24)",
                "intNum": 1000010,
                "ipAddress": "10.30.10.1",
                "receive": 0.0,
                "source": "bostonsw1-stout",
                "target": "Cloud-10.30.10.0",
                "transmit": 0.0,
                "url": "Devices.html?d=47&i=1000010",
                "warning": 0
            },
            {
                "DevNum": 48,
                "LastChanged": "104 days 14:49:45.65",
                "MTU": 1500,
                "QoS": "CBQoS",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 1,
                "ipAddress": "192.168.30.1",
                "receive": 0.0,
                "source": "Boston",
                "target": "Cloud-192.168.30.0",
                "transmit": 0.0,
                "url": "Devices.html?d=48&i=1",
                "warning": 0
            },
            {
                "DevNum": 48,
                "LastChanged": "104 days 14:48:44.34",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/1: FastEthernet0/1",
                "intNum": 2,
                "ipAddress": "10.30.0.2",
                "receive": 0.0,
                "source": "Boston",
                "target": "Cloud-10.30.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=48&i=2",
                "warning": 0
            },
            {
                "DevNum": 50,
                "LastChanged": "34 days 16:10:15.83",
                "MTU": 1500,
                "QoS": "WFQ",
                "bandwidth": 512000,
                "errors": 0.0,
                "intDescription": "Se0/0/0: Serial0/0/0",
                "intNum": 1,
                "ipAddress": "10.50.1.1",
                "receive": 0.0,
                "source": "Sunnyvale",
                "target": "Cloud-10.50.1.0",
                "transmit": 0.0,
                "url": "Devices.html?d=50&i=1",
                "warning": 0
            },
            {
                "DevNum": 50,
                "LastChanged": "7 days 22:39:53.22",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.50.0.2",
                "receive": 0.0,
                "source": "Sunnyvale",
                "target": "Cloud-10.50.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=50&i=2",
                "warning": 0
            },
            {
                "DevNum": 59,
                "LastChanged": "34 days 16:09:41.06",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 512000,
                "errors": 0.0,
                "intDescription": "Se0/0/0: Serial0/0/0",
                "intNum": 1,
                "ipAddress": "10.50.1.2",
                "receive": 0.0,
                "source": "Pacifica",
                "target": "Cloud-10.50.1.0",
                "transmit": 0.0,
                "url": "Devices.html?d=59&i=1",
                "warning": 0
            },
            {
                "DevNum": 59,
                "LastChanged": "34 days 16:06:41.09",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.50.4.1",
                "receive": 0.0,
                "source": "Pacifica",
                "target": "Cloud-10.50.4.0",
                "transmit": 0.0,
                "url": "Devices.html?d=59&i=2",
                "warning": 0
            },
            {
                "DevNum": 59,
                "LastChanged": "34 days 16:06:38.09",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 10000000,
                "errors": 0.0,
                "intDescription": "Fa0/1: FastEthernet0/1",
                "intNum": 3,
                "ipAddress": "10.50.3.1",
                "receive": 0.0,
                "source": "Pacifica",
                "target": "Cloud-10.50.3.0",
                "transmit": 0.0,
                "url": "Devices.html?d=59&i=3",
                "warning": 0
            },
            {
                "DevNum": 62,
                "LastChanged": "104 days 15:02:45.80",
                "MTU": 1500,
                "QoS": "WFQ",
                "bandwidth": 1536000,
                "errors": 0.0,
                "intDescription": "Se0/0/0: Serial0/0/0",
                "intNum": 1,
                "ipAddress": "192.168.60.2",
                "receive": 0.0,
                "source": "Chicago",
                "target": "Cloud-192.168.60.0",
                "transmit": 0.0,
                "url": "Devices.html?d=62&i=1",
                "warning": 0
            },
            {
                "DevNum": 62,
                "LastChanged": "104 days 15:02:50.18",
                "MTU": 1500,
                "QoS": "FIFO",
                "bandwidth": 100000000,
                "errors": 0.0,
                "intDescription": "Fa0/0: FastEthernet0/0",
                "intNum": 2,
                "ipAddress": "10.60.0.1",
                "receive": 0.0,
                "source": "Chicago",
                "target": "Cloud-10.60.0.0",
                "transmit": 0.0,
                "url": "Devices.html?d=62&i=2",
                "warning": 0
            }
        ],
        "subnets": [
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.86.0.0",
                "subnet": "10.86.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.0.0.0",
                "subnet": "10.0.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.142.0.0",
                "subnet": "10.142.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.199.0.0",
                "subnet": "10.199.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": false,
                "mask": "255.255.255.248",
                "name": "Cloud-104.8.32.104",
                "subnet": "104.8.32.104"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-192.168.100.0",
                "subnet": "192.168.100.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.200.10.0",
                "subnet": "10.200.10.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.200.99.0",
                "subnet": "10.200.99.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": false,
                "mask": "255.255.255.252",
                "name": "Cloud-100.65.66.0",
                "subnet": "100.65.66.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.200.123.0",
                "subnet": "10.200.123.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.200.20.0",
                "subnet": "10.200.20.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.200.30.0",
                "subnet": "10.200.30.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.1.0.0",
                "subnet": "10.1.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.10.0.0",
                "subnet": "10.10.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.10.30.0",
                "subnet": "10.10.30.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.10.40.0",
                "subnet": "10.10.40.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.10.50.0",
                "subnet": "10.10.50.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-172.17.10.0",
                "subnet": "172.17.10.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.252",
                "name": "Cloud-192.168.10.0",
                "subnet": "192.168.10.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.252",
                "name": "Cloud-192.168.60.0",
                "subnet": "192.168.60.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.51.0.0",
                "subnet": "10.51.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": false,
                "mask": "255.255.252.0",
                "name": "Cloud-99.145.204.0",
                "subnet": "99.145.204.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.252",
                "name": "Cloud-10.51.250.0",
                "subnet": "10.51.250.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.51.20.0",
                "subnet": "10.51.20.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.252",
                "name": "Cloud-10.51.251.0",
                "subnet": "10.51.251.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.51.30.0",
                "subnet": "10.51.30.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.30.0.0",
                "subnet": "10.30.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.30.10.0",
                "subnet": "10.30.10.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.192",
                "name": "Cloud-192.168.30.0",
                "subnet": "192.168.30.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.50.0.0",
                "subnet": "10.50.0.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.50.1.0",
                "subnet": "10.50.1.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.50.3.0",
                "subnet": "10.50.3.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.50.4.0",
                "subnet": "10.50.4.0"
            },
            {
                "image": "assets/Graphics/cloud.png",
                "isPrivate": true,
                "mask": "255.255.255.0",
                "name": "Cloud-10.60.0.0",
                "subnet": "10.60.0.0"
            }
        ]
      };

      return new Promise((resolve, reject) => {
        resolve(data);
        // d3.json(url, (error, graph) => {
        //   if (error) {
        //     reject(error)
        //   } else {
        //     resolve(graph)
        //   }
        // })
      })
    }
  }

  const UI = {
    toolbar: {
      searchForm: {
        search(diagram, value) {
          let exactMatch = Utils.findAndFocus(diagram, value)

          if (!exactMatch) {
            let items = diagram.dom.searchAutocompleteList.children
            if (items && items.length > 0) {
              items[0].click()
            }
          }
        },
        autocompleteSetup(diagram, input) {
          const { dom } = diagram
          let list,
              currentFocus = -1

          function setActive(items) {
            if (!items) return false
            items[currentFocus].classList.add("autocomplete-active")
          }
          function removeActive(items) {
            if (!items || currentFocus < 0) return false
            items[currentFocus].classList.remove("autocomplete-active")
          }

          input.addEventListener("input", () => {
            const val = input.value,
                  items = diagram.autocompleteItems
            if (!val) return false
            if (list) list.remove()
            currentFocus = -1
            list = dom.searchAutocompleteList = document.createElement("div")
            list.setAttribute("class", "autocomplete-items")
            input.parentNode.appendChild(list)
            items.forEach(item => {
              /*check if the item starts with the same letters as the text field value:*/
              if (item.substr(0, val.length).toUpperCase() !== val.toUpperCase()) return
              /*create a DIV element for each matching element:*/
              const itemEl = document.createElement("div")
              /*make the matching letters bold:*/
              itemEl.innerHTML = `<strong>${item.substr(0, val.length)}</strong>${item.substr(val.length)}`
              /*insert a input field that will hold the current array item's value:*/
              itemEl.innerHTML += `<input type='hidden' value='${item}'>`
              itemEl.addEventListener("click", () => {
                input.value = item
                Utils.findAndFocus(diagram, item)
                list.remove()
              })
              itemEl.style.height = "20px"
              itemEl.style.padding = "5px"
              itemEl.style.fontSize = "12px"
              itemEl.style.width = "300px"
              list.appendChild(itemEl)
            })
          })
          /*execute a function presses a key on the keyboard:*/
          input.addEventListener("keydown", e => {
            let items = list ? list.querySelectorAll("div") : null

            if (e.keyCode === 40) { // down
              removeActive(items)
              currentFocus++
              setActive(items)
            } else if (e.keyCode === 38) { // up
              removeActive(items)
              currentFocus--
              setActive(items)
            } else if (e.keyCode === 13) { // enter
              e.preventDefault() // stops form from submitting

              let exactMatch = Utils.findAndFocus(diagram, input.value)
              if (!exactMatch) {
                if (currentFocus > -1 && items.length > currentFocus) {
                  items[currentFocus].click()
                  // simulate a click on the 'active' item if any
                } else if (!exactMatch && items.length > 0) {
                  // or on the first element in the list
                  items[0].click()
                }
              }
            }
          })

          // close the list when clicking outside of it
          Utils.registerDocumentEventListener(diagram, "click", e => {
            if (list && list !== e.target) list.remove()
          })
        },
      },
      styleModeButtons({ dom, settings }) {
        if (settings.floatMode) {
          dom.toolbar.querySelector(".button.float").style.fill = "black"
          dom.toolbar.querySelector(".button-label.float").style.fill = "white"
          dom.toolbar.querySelector(".button.lock").style.fill = "white"
          dom.toolbar.querySelector(".button-label.lock").style.fill = "#596877"
        } else {
          dom.toolbar.querySelector(".button.lock").style.fill = "black"
          dom.toolbar.querySelector(".button-label.lock").style.fill = "white"
          dom.toolbar.querySelector(".button.float").style.fill = "white"
          dom.toolbar.querySelector(".button-label.float").style.fill = "#596877"
        }
      },
      toggle({ dom, settings }) {
        settings.toolbar = !settings.toolbar
        dom.toolbar.style.display = settings.toolbar ? "block" : "none"
      },
      create(diagram) {
        const { dom, settings, autocompleteItems } = diagram,
              toolbar = dom.toolbar = document.createElement("div")

        toolbar.classList.add("toolbar")
        toolbar.innerHTML += `
          <form class="search-form" autocomplete="off">
            <div class="autocomplete">
              <input type="text" placeholder="Search">
            </div>
            <svg class="button search">
              <g>
                <rect height="100%" width="34px"></rect>
                <text class="button-label" x="3" y="13">Search</text>
              </g>
            </svg>
          </form>
          <svg class="zoom-controls">
            <g>
              <g class="zoom-in">
                <rect class="plusMinusBox" width="19px" height="100%"></rect>
                <line id="plusHorizontal" x1="4.5" y1="10" x2="14.5" y2="10"></line>
                <line id="plusVertical" x1="9.5" y1="5" x2="9.5" y2="15"></line>
              </g>
              <g class="zoom-out">
                <rect class="plusMinusBox" width="19px" height="100%"></rect>
                <line id="minusLine" x1="4.5" y1="10" x2="14.5" y2="10"></line>
              </g>
            </g>
          </svg>
          <svg class="mode-toggle">
            <g class="button float">
              <rect height="100%" width="30px"></rect>
              <text class="button-label float" x="4.5" y="13">Float</text>
            </g>
            <g class="button lock">
              <rect height="100%" width="30px"></rect>
              <text class="button-label lock" x="5" y="13">Lock</text>
            </g>
          </svg>
          <div class="button visio-export">
            <img src="assets/img/VisioIcon.png"/>
          </div>
          <div class="button detach">
            <a onclick="openWindow('DiagramDetach.html',1000,600)">Detach</a>
          </div>
          <div class="ip-toggle">
            <input type="checkbox" />
            <label class="label">Show IP Address</label>
          </div>
          <svg class="reset button">
            <g>
              <rect height="100%" width="30px"></rect>
              <text class="button-label" x="3" y="13">Reset</text>
            </g>
          </svg>
          <div class="help">&lt;SHIFT&gt;+click on an element to interact</div>
        `

        const searchFormInput = toolbar.querySelector(".search-form input")

        toolbar.querySelector(".zoom-in").addEventListener("click", () => Zoom.increment(diagram))
        toolbar.querySelector(".zoom-out").addEventListener("click", () => Zoom.decrement(diagram))
        toolbar.querySelector(".button.float").addEventListener("click", () => !settings.floatMode && toggleFloatMode(diagram))
        toolbar.querySelector(".button.lock").addEventListener("click", () => settings.floatMode && toggleFloatMode(diagram))
        toolbar.querySelector(".button.visio-export").addEventListener("click", () => doVisioExport(diagram))
        toolbar.querySelector(".button.reset").addEventListener("click", () => reset(diagram))
        toolbar.querySelector(".button.search").addEventListener("click", () => this.searchForm.search(diagram, searchFormInput.value))
        
        // const groupingToggle = toolbar.querySelector(".groupings-toggle input")
        // groupingToggle.checked = settings.grouping
        // groupingToggle.addEventListener("click", () => Grouping.toggle(diagram))

        const ipAddressToggle = toolbar.querySelector(".ip-toggle input");
        ipAddressToggle.checked = settings.showIpAddress;
        ipAddressToggle.addEventListener("click", () => IpAddress.toggle(diagram))

        this.searchForm.autocompleteSetup(diagram, searchFormInput, autocompleteItems)
        this.styleModeButtons(diagram)

        // hide if toggled off
        if (!settings.toolbar) toolbar.style.display = "none"

        return toolbar
      }
    },
    teardown({ dom }) {
      const containerEl = dom.container.node()

      while (containerEl.firstElementChild) {
        containerEl.firstElementChild.remove()
      }
    },
    loading: {
      start({ dom }) {
        dom.spinner = dom.container.append("rect").attr("class", "loader")
      },
      finish({ dom }) {
        dom.spinner.remove()
      },
    },

    
    create(diagram, container) {
      const dom = diagram.dom = {}

      dom.container = d3.select(container).classed("diagram", true).classed("widget-mode", Utils.isWidget())
      dom.container.append(() => this.toolbar.create(diagram))
      dom.visContainer = dom.container.append("div")
        .style("position", "relative")
        .style("width", "100%")
        .style("height", "100%")
        .attr("class", "grabbable")
      dom.tooltipDiv = dom.container
        .append("div")
        .attr("class", "tooltip")
        .style("opacity", 0)
        .style("z-index", 9999)
    }
  }

  function doVisioExport({ nodes, edges, groups, focusedGroup }) {
    let data,
        name = "TotalView Diagram-"

    if (focusedGroup > -1) {
      data = {
        nodes: nodes.filter(n => n.group === focusedGroup),
        edges: edges.filter(e => e.source.group === focusedGroup && e.target.group === focusedGroup),
      }
      name += groups[focusedGroup].name
    } else {
      data = { nodes, edges, groups }
      name += "Main"
    }
    visioExport.generate(data, name)
  }

  function toggleFloatMode(diagram) {
    diagram.settings.floatMode = !diagram.settings.floatMode
    UI.toolbar.styleModeButtons(diagram)
  }

  const Layers = {
    init(diagram) {
      const layers = diagram.layers = [];

      [
        "nodes",
        "edges",
        "graphics",
        "simulations",
        "autocompleteItems",
        "focusedGroup",
        "transform",
        "zoomBehavior",
        "groups",
      ].forEach(key => {
        Object.defineProperty(diagram, key, {
          get() {
            return layers[0][key]
          },
          set(val) {
            layers[0][key] = val
          }
        })
      });
      ["svg", "layerContainer", "groupsContainer"].forEach(key => {
        Object.defineProperty(diagram.dom, key, {
          get() {
            return layers[0].dom[key]
          },
          set(val) {
            layers[0].dom[key] = val
          }
        })
      })
      Object.defineProperty(diagram, "currentLayer", {
        get() {
          return layers[0]
        }
      })
    },
    async toggle(layer, show, duration = 1000) {
      Object.values(layer.dom).forEach(el => {
        el.transition().duration(duration).ease(d3.easeLinear).style("opacity", show ? 1 : 0)
      })
      return new Promise(resolve => setTimeout(resolve, duration))
    },
    async push(id, diagram, data, { delay, fadeDuration } = { delay: 0, fadeDuration: 1000 }) {
      const layer = {
        id,
        diagram,
        dom: {},
        graphics: {},
        autocompleteItems: [],
        focusedGroup: -1,
        settings: diagram.settings,
        processing: true
      },
      first = diagram.layers ? false : true

      if (first) this.init(diagram)
      diagram.layers.unshift(layer)

      layer.dom.svg = diagram.dom.visContainer.append("svg")
        .style("width", "100%").style("height", "100%")

      if (!first) {
        const visContainer = diagram.dom.visContainer.node()

        layer.dom.svg
          .style("width", visContainer.clientWidth - 60)
          .style("height", visContainer.clientHeight - 60)
          .style("position", "absolute")
          .style("background", "transparent")
          .style("left", 40)
          .style("top", 30)
          .style("z-index", diagram.layers.length + 1)
          .style("opacity", 0)

        Grouping.box(diagram, layer.dom.svg)
          .attr("x", 5)
          .attr("y", 5)
          .attr('class', 'test')
          .style("width", "calc(100% - 10px)")
          .style("height", "calc(100% - 10px)")
          .attr("fill", "#eee")
        layer.dom.closeButton = diagram.dom.visContainer.append("img")
          .attr("src", "assets/img/close.png")
          .attr("class", "clickable")
          .style("height", "30px")
          .style("width", "30px")
          .style("position", "absolute")
          .style("z-index", 999)
          .style("top", "25px")
          .style("left", visContainer.clientWidth - 60 + "px")
        layer.dom.closeButton.on("click", function() {
          Layers.remove(layer)
        })
      }
      layer.dom.layerContainer = layer.dom.svg.append("g")
      Zoom.init(diagram, layer)

      // then we show the loading spinner in case data fetching takes a while
      UI.loading.start(diagram)

      if (!first) {
        setTimeout(() => {
          this.toggle(layer, true, fadeDuration)
        }, delay)
      }

      // then we wait for and parse the data
      Data.process(layer, await data)

      Graphics.create(diagram, layer)

      layer.dom.groupsContainer = layer.dom.layerContainer.append("g").attr("class", "groups")

      if (!first) {
        Grouping.box(diagram, layer.dom.svg)
          .attr("x", 5)
          .attr("y", 5)
          .style("width", "calc(100% - 10px)")
          .style("height", "calc(100% - 10px)")
          .attr("fill", "none")
      }

      UI.loading.finish(diagram)

      return layer
    },
    async remove(layer) {
      if (layer.processing) return
      layer.processing = true
      layer.diagram.layers.splice(layer.diagram.layers.findIndex(l => layer === l), 1)
      await this.toggle(layer, false)
      Object.values(layer.dom).forEach(el => el.remove())
    },
    drillDown: {
      apiUrl: "api/diagramlayer2.json",
      async device(diagram, node) {
        let dataPromise = Data.fetch(`${this.apiUrl}?device=${node.name}`).then(data => ({
          ...data,
          devices: [_.cloneDeep(node), ...data.links.map(link => ({
            name: link.target
          }))]
        }))

        const targetZoom = Math.max(1.5, diagram.transform.k)
        await Zoom.focusOnNode(diagram, node, targetZoom, 250)

        const layer = await Layers.push(node.name, diagram, dataPromise)

        await dataPromise.then(data => {
          const newNode = Utils.findNode(layer, node.name),
                radius = Math.max(diagram.dom.svg.node().clientHeight, diagram.dom.svg.node().clientWidth) + 100,
                separation = (360 / data.links.length) * Math.PI / 180

          newNode.x = layer.dom.svg.node().clientWidth / 2
          newNode.y = layer.dom.svg.node().clientHeight / 2
          Zoom.focusOnNode(diagram, newNode, targetZoom, 0)

          data.links.forEach((link, i) => {
            link.source = newNode
            link.target.x = newNode.x + (Math.cos(separation * i) * radius)
            link.target.y = newNode.y + (Math.sin(separation * i) * radius)
          })

          Graphics.update(layer)

          Zoom.restrictArea(layer)
          layer.zoomBehavior.scaleExtent([targetZoom, diagram.settings.maxZoomIn])
        })

        return layer
      },
      async subnet(diagram, node) {
        let dataPromise = Data.fetch(`${this.apiUrl}?subnet=${node.subnet}`).then(data => ({
          ...data,
          devices: data.devices.concat(
            data.links.reduce((missing, { source, target }) => {
              if (!data.devices.find(({ name }) => source === name)) {
                missing.push({ name: source, external: true })
              } else if (!data.devices.find(({ name }) => target === name)) {
                missing.push({ name: target, external: true })
              }
              return missing
            }, [])
          )
        }))

        await Zoom.focusOnNode(diagram, node, Math.max(1.5, diagram.transform.k), 250)

        const layer = await Layers.push(node.name, diagram, dataPromise, {
          delay: 0,
          fadeDuration: 500
        })

        Simulations.init(diagram)
        await dataPromise.then(data => {
          const nodes = data.devices.filter(device => !device.external),
                group = Grouping.fromNodes(diagram, nodes),
                radius = Math.max(diagram.dom.svg.node().clientHeight, diagram.dom.svg.node().clientWidth) + 100,
                externalDevices = data.devices.filter(n => n.external),
                separation = Math.min(((360 / externalDevices.length) * Math.PI / 180), 0.5)

          externalDevices.forEach((node, i) => {
            const external = Utils.findNode(layer, node.name),
                  svg = diagram.dom.svg.node()

            external.x = external.fx = group.cx + (Math.cos(separation * i) * radius) + svg.clientWidth
            external.y = external.fy = group.cy + (Math.sin(separation * i) * radius) + svg.clientHeight
          })
          Graphics.update(layer)

          // this waits until the simulation positions the nodes
          return new Promise(resolve => {
            setTimeout(async () => {
              Grouping.polygonGenerator(diagram, group, nodes)
              await Zoom.focusOnArea(diagram, group)

              Zoom.restrictArea(layer)
              layer.zoomBehavior.scaleExtent([layer.transform.k, diagram.settings.maxZoomIn])

              resolve()
            }, 500)
          })
        })

        return layer
      },
      async do(diagram, node) {
        let layer

        if (node.isCloud) {
          layer = await this.subnet(diagram, node)
        } else {
          layer = await this.device(diagram, node)
        }

        layer.processing = false
      }
    }
  }

  function reset(diagram) {
    if (!confirm("Are you sure you want to clear all saved locations and revert all devices to natural float?")) return
    // clear stored layout and zoom
    Layout.clear(diagram)
    Zoom.clear(diagram)
    location.reload()
  }

  function destroy(diagram, publicInstance) {
    Utils.cleanEventListeners(diagram)
    Simulations.teardown(diagram)
    UI.teardown(diagram)

    Object.keys(publicInstance).forEach(key => delete publicInstance[key])
    Object.keys(diagram).forEach(key => delete diagram[key])
    diagram = null
  }

  function updateSettings(diagram, newSettings) {
    const flags = ["toolbar", "grouping", "floatMode", 'showIpAddress'],
          { settings } = diagram
    let zoomParametersChanged = false

    Object.keys(newSettings).forEach(key => {
      const value = newSettings[key]

      // if value is a boolean flag and is set to change
      if (flags.includes(key) && value !== settings[key]) {
        // validate that flag value is a boolean
        if (typeof value !== "boolean") throw new Error(`${key} must be a boolean value`)
        // execute the corresponding method
        switch(key) {
          case "toolbar":
            UI.toolbar.toggle(diagram)
            break
          case "grouping":
            Grouping.toggle(diagram)
            break
          case 'showIpAddress':
            IpAddress.toggle(diagram);
            break;
          case "floatMode":
            toggleFloatMode()
            break
        }
      } else {
        switch(key) {
          case "maxZoomIn":
          case "maxZoomOut":
            zoomParametersChanged = true
            break
          default:
            break
        }
        settings[key] = value
      }
    })

    if (zoomParametersChanged) {
      Zoom.applySettings(diagram)
    }
  }

  /**
   * Create a diagram instance
   * @param {string} id - An identifier for the diagram. This is used as part of the key to isolate persistent settings in localStorage.
   * @param {Object} container - The container DOM node.
   * @param {Object} settings - Settings object.
   * @param {boolean} settings.toolbar - flag for toolbar showing up
   * @param {boolean} settings.grouping - flag for grouping
   * @param {boolean} settings.floatMode - flag for float/lock mode toggle (true = float mode)
   * @param {number} settings.groupPadding - padding between groups that the simulation tries to maintain
   * @param {number} settings.groupBorderWidth - group border width
   * @param {number} settings.zoomInMult - zoom increment multiplier
   * @param {number} settings.zoomOutMult - zoom decrement multiplier
   * @param {number} settings.maxZoomIn - maximum allowed zoom value
   * @param {number} settings.maxZoomOut - minimum allowed zoom value
   */
  async function create(id, container, settings = {}) {
    const diagram = {
      id,
      dom: { container },
      docEventListeners: []
    }
    diagram.settings = Object.assign({
      toolbar: false,
      grouping: Store.get(diagram, "grouping") !== "false",
      showIpAddress: Store.get(diagram, "showIpAddress") !== 'false',
      floatMode: true,
      groupPadding: 75,
      groupBorderWidth: 10,
      zoomInMult: 1.25,
      zoomOutMult: 0.8,
      maxZoomIn: 8,
      maxZoomOut: 0.1,
    }, settings)

    UI.create(diagram, container)
    const layer = await Layers.push("main", diagram, Data.fetch("api/diagramlayer3.json"));
    
    layer.processing = false
    Simulations.init(diagram, layer)
    IpAddress.init(diagram, layer)
    Layout.restore(diagram, layer)
    Zoom.restore(diagram, layer)
    Grouping.init(diagram, layer)

    return {
      destroy() { destroy(diagram, this) },
      reset: () => reset(diagram),
      doVisioExport: () => doVisioExport(diagram),
      updateSettings: (newSettings) => updateSettings(diagram, newSettings),
      toggleFloatMode: () => toggleFloatMode(diagram),
      toggleIpAddress: () => IpAddress.toggle(diagram),
      toggleToolbar: () => UI.toolbar.toggle(diagram)
    }
  }

  return { create, updateSettings }
}()
