window.Hyumu = window.Hyumu || {};

Hyumu.Scheduler = (function () {
  const Model = Hyumu.Model;

  function setCell(schedule, empId, date, status, source, shift) {
    schedule[empId][date] = { status, source, shift: shift || null };
  }

  function isLocked(schedule, empId, date) {
    const cell = schedule[empId][date];
    return !!cell && (cell.source === 'BASE' || cell.source === 'MANUAL');
  }

  function generateSchedule(doc) {
    const { employees, rules, month } = doc;
    const dates = Model.allDatesOfMonth(month.year, month.month);
    const n = employees.length;

    const schedule = {};
    employees.forEach((emp) => {
      schedule[emp.id] = {};
    });

    // BASE cells are always recomputed fresh from employee definitions
    for (const emp of employees) {
      for (const date of dates) {
        if (Model.isBaseOff(emp, date)) {
          setCell(schedule, emp.id, date, 'OFF', 'BASE');
        }
      }
    }

    // carry forward previously saved MANUAL locks
    if (doc.schedule) {
      for (const emp of employees) {
        const prevEmp = doc.schedule[emp.id];
        if (!prevEmp) continue;
        for (const date of dates) {
          const prevCell = prevEmp[date];
          if (prevCell && prevCell.source === 'MANUAL') {
            setCell(schedule, emp.id, date, prevCell.status, 'MANUAL', prevCell.shift);
          }
        }
      }
    }

    const conflicts = [];

    if (n === 0) {
      doc.schedule = schedule;
      doc.conflicts = conflicts;
      return doc;
    }

    const consecutiveWork = {};
    const totalOff = {};
    const weekendOff = {};
    const redDayOff = {};
    employees.forEach((emp) => {
      consecutiveWork[emp.id] = 0;
      totalOff[emp.id] = 0;
      weekendOff[emp.id] = 0;
      redDayOff[emp.id] = 0;
    });

    const lockedOffCount = {};
    employees.forEach((emp) => {
      lockedOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF') lockedOffCount[emp.id]++;
      }
    }

    let totalOffSlots = 0;
    for (const date of dates) {
      const req = Model.minStaffRequired(rules, date);
      totalOffSlots += Math.max(0, n - req);
    }
    const baseTarget = totalOffSlots / n;
    const target = {};
    employees.forEach((emp) => {
      target[emp.id] = Math.max(lockedOffCount[emp.id], baseTarget);
    });

    const cap = rules.maxConsecutiveWorkDays;
    const effectiveCap = rules.minRestPerWeekWindow ? Math.min(cap, 6) : cap;
    const shiftMinTotal = (rules.minMorningStaff || 0) + (rules.minAfternoonStaff || 0);

    const cornerShiftMin = rules.minStaffByCorner || {};
    const cornerMinStaff = {};
    Object.entries(cornerShiftMin).forEach(([corner, req]) => {
      cornerMinStaff[corner] = (req.morning || 0) + (req.afternoon || 0);
    });
    const cornerTotal = {};
    employees.forEach((emp) => {
      if (emp.corner) cornerTotal[emp.corner] = (cornerTotal[emp.corner] || 0) + 1;
    });

    // Phase 1: chronological greedy fill
    for (const date of dates) {
      const weekend = Model.isWeekend(date);
      const redDay = Model.isRedDay(date);
      const req = Math.max(Model.minStaffRequired(rules, date), shiftMinTotal);

      const lockedEmployees = [];
      const freeEmployees = [];
      for (const emp of employees) {
        if (isLocked(schedule, emp.id, date)) lockedEmployees.push(emp);
        else freeEmployees.push(emp);
      }
      const fixedOffCount = lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').length;

      if (n - fixedOffCount < req) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 고정/수동 휴무만으로 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
          employeeIds: lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').map((e) => e.id)
        });
      }

      const allowedAdditionalOff = Math.max(0, n - req - fixedOffCount);

      const forcedOff = freeEmployees.filter((emp) => consecutiveWork[emp.id] >= effectiveCap);
      const forcedIds = new Set(forcedOff.map((e) => e.id));

      if (forcedOff.length > allowedAdditionalOff) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 연속 근무 제한(${effectiveCap}일)으로 쉬어야 하는 인원이 많아 최소 근무 인원(${req}명)을 유지할 수 없습니다.`,
          employeeIds: forcedOff.map((e) => e.id)
        });
      }

      forcedOff.forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FORCED'));

      const remainingSlots = Math.max(0, allowedAdditionalOff - forcedOff.length);
      const candidates = freeEmployees.filter((emp) => !forcedIds.has(emp.id));

      // Per-corner remaining OFF budget: locked/forced-off corner members already consumed some
      const cornerOffUsed = {};
      [...lockedEmployees.filter((e) => schedule[e.id][date].status === 'OFF'), ...forcedOff].forEach((emp) => {
        if (emp.corner) cornerOffUsed[emp.corner] = (cornerOffUsed[emp.corner] || 0) + 1;
      });
      const cornerAllowedOff = {};
      Object.keys(cornerTotal).forEach((corner) => {
        cornerAllowedOff[corner] = Math.max(0, cornerTotal[corner] - (cornerMinStaff[corner] || 0));
      });
      Object.entries(cornerOffUsed).forEach(([corner, used]) => {
        if (cornerAllowedOff[corner] != null && used > cornerAllowedOff[corner]) {
          conflicts.push({
            date,
            type: 'CORNER_MIN_STAFF_VIOLATION',
            message: `${date}: 고정/수동/강제 휴무만으로 '${corner}' 코너 최소 인원(${cornerMinStaff[corner] || 0}명)을 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      });

      candidates.sort((a, b) => {
        const deficitA = target[a.id] - totalOff[a.id];
        const deficitB = target[b.id] - totalOff[b.id];
        if (deficitB !== deficitA) return deficitB - deficitA;
        if (redDay) {
          const rDiff = redDayOff[a.id] - redDayOff[b.id];
          if (rDiff !== 0) return rDiff;
        }
        if (weekend) {
          const wDiff = weekendOff[a.id] - weekendOff[b.id];
          if (wDiff !== 0) return wDiff;
        }
        const streakDiff = consecutiveWork[b.id] - consecutiveWork[a.id];
        if (streakDiff !== 0) return streakDiff;
        return employees.indexOf(a) - employees.indexOf(b);
      });

      const chosenOff = [];
      for (const emp of candidates) {
        if (chosenOff.length >= remainingSlots) break;
        const corner = emp.corner;
        if (corner && cornerAllowedOff[corner] != null) {
          const used = cornerOffUsed[corner] || 0;
          if (used >= cornerAllowedOff[corner]) continue;
        }
        chosenOff.push(emp);
        if (corner) cornerOffUsed[corner] = (cornerOffUsed[corner] || 0) + 1;
      }
      const chosenOffIds = new Set(chosenOff.map((e) => e.id));

      candidates.filter((emp) => chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FAIRNESS'));
      candidates.filter((emp) => !chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'WORK', 'AUTO'));

      for (const emp of employees) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF') {
          consecutiveWork[emp.id] = 0;
          totalOff[emp.id]++;
          if (weekend) weekendOff[emp.id]++;
          if (redDay) redDayOff[emp.id]++;
        } else {
          consecutiveWork[emp.id]++;
        }
      }
    }

    rebalance(schedule, employees, dates, effectiveCap, totalOff, conflicts);
    assignShifts(schedule, employees, dates, rules, conflicts);

    doc.schedule = schedule;
    doc.conflicts = conflicts;
    return doc;
  }

  function assignShifts(schedule, employees, dates, rules, conflicts) {
    const minMorning = rules.minMorningStaff || 0;
    const minAfternoon = rules.minAfternoonStaff || 0;
    const cornerShiftMin = rules.minStaffByCorner || {};
    const hasCornerShiftReq = Object.values(cornerShiftMin).some((req) => (req.morning || 0) > 0 || (req.afternoon || 0) > 0);
    if (minMorning === 0 && minAfternoon === 0 && !hasCornerShiftReq && !employees.some((e) => e.shiftPreference !== 'ANY')) {
      return;
    }

    const morningCount = {};
    const afternoonCount = {};
    employees.forEach((e) => {
      morningCount[e.id] = 0;
      afternoonCount[e.id] = 0;
    });

    for (const date of dates) {
      const workingToday = employees.filter((e) => schedule[e.id][date] && schedule[e.id][date].status === 'WORK');

      const lockedMorning = [];
      const lockedAfternoon = [];
      let flexible = [];

      for (const e of workingToday) {
        const cell = schedule[e.id][date];
        if (cell.source === 'MANUAL' && cell.shift) {
          if (cell.shift === 'MORNING') lockedMorning.push(e);
          else lockedAfternoon.push(e);
        } else if (e.shiftPreference === 'MORNING') {
          lockedMorning.push(e);
        } else if (e.shiftPreference === 'AFTERNOON') {
          lockedAfternoon.push(e);
        } else {
          flexible.push(e);
        }
      }

      const byMorningNeedAsc = (a, b) =>
        (morningCount[a.id] - afternoonCount[a.id]) - (morningCount[b.id] - afternoonCount[b.id]);

      // Corner-level minimums are satisfied first, pulling from that corner's flexible pool only
      Object.entries(cornerShiftMin).forEach(([corner, req]) => {
        const needM = req.morning || 0;
        const needA = req.afternoon || 0;
        if (needM === 0 && needA === 0) return;
        const cornerWorking = workingToday.filter((e) => e.corner === corner);
        const cornerLockedM = lockedMorning.filter((e) => e.corner === corner).length;
        const cornerLockedA = lockedAfternoon.filter((e) => e.corner === corner).length;
        const cornerFlexible = flexible.filter((e) => e.corner === corner);
        const remainM = Math.max(0, needM - cornerLockedM);
        const remainA = Math.max(0, needA - cornerLockedA);

        if (remainM + remainA > cornerFlexible.length) {
          conflicts.push({
            date,
            type: 'CORNER_SHIFT_MIN_VIOLATION',
            message: `${date}: '${corner}' 코너 오전/오후 최소 인원(오전 ${needM}명, 오후 ${needA}명)을 채울 인원이 부족합니다.`,
            employeeIds: cornerWorking.map((e) => e.id)
          });
        }

        cornerFlexible.sort(byMorningNeedAsc);
        const pickM = cornerFlexible.slice(0, remainM);
        const pickMIds = new Set(pickM.map((e) => e.id));
        const remainingCornerFlex = cornerFlexible.filter((e) => !pickMIds.has(e.id));
        remainingCornerFlex.sort((a, b) => byMorningNeedAsc(b, a));
        const pickA = remainingCornerFlex.slice(0, remainA);
        const pickAIds = new Set(pickA.map((e) => e.id));

        flexible = flexible.filter((e) => !pickMIds.has(e.id) && !pickAIds.has(e.id));
        lockedMorning.push(...pickM);
        lockedAfternoon.push(...pickA);
      });

      const needMorning = Math.max(0, minMorning - lockedMorning.length);
      const needAfternoon = Math.max(0, minAfternoon - lockedAfternoon.length);

      if (needMorning + needAfternoon > flexible.length) {
        conflicts.push({
          date,
          type: 'SHIFT_MIN_VIOLATION',
          message: `${date}: 오전/오후 최소 인원(오전 ${minMorning}명, 오후 ${minAfternoon}명)을 모두 채울 인원이 부족합니다.`,
          employeeIds: workingToday.map((e) => e.id)
        });
      }

      flexible.sort(byMorningNeedAsc);
      const chosenMorning = flexible.slice(0, needMorning);
      const chosenMorningIds = new Set(chosenMorning.map((e) => e.id));
      const afterMorningPick = flexible.filter((e) => !chosenMorningIds.has(e.id));

      afterMorningPick.sort((a, b) => byMorningNeedAsc(b, a));
      const chosenAfternoon = afterMorningPick.slice(0, needAfternoon);
      const chosenAfternoonIds = new Set(chosenAfternoon.map((e) => e.id));
      const leftover = afterMorningPick.filter((e) => !chosenAfternoonIds.has(e.id));

      let dayMorningCount = lockedMorning.length + chosenMorning.length;
      let dayAfternoonCount = lockedAfternoon.length + chosenAfternoon.length;

      leftover.sort(byMorningNeedAsc);
      for (const e of leftover) {
        const diff = morningCount[e.id] - afternoonCount[e.id];
        const assignMorning = diff < 0 || (diff === 0 && dayMorningCount <= dayAfternoonCount);
        if (assignMorning) {
          chosenMorning.push(e);
          dayMorningCount++;
        } else {
          chosenAfternoon.push(e);
          dayAfternoonCount++;
        }
      }

      [...lockedMorning, ...chosenMorning].forEach((e) => {
        schedule[e.id][date].shift = 'MORNING';
      });
      [...lockedAfternoon, ...chosenAfternoon].forEach((e) => {
        schedule[e.id][date].shift = 'AFTERNOON';
      });

      for (const e of workingToday) {
        if (schedule[e.id][date].shift === 'MORNING') morningCount[e.id]++;
        else afternoonCount[e.id]++;
      }
    }
  }

  function rebalance(schedule, employees, dates, effectiveCap, totalOff, conflicts) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * dates.length * 4;
    let iterations = 0;

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = dates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, dates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < dates.length && statusOn(empId, dates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > effectiveCap;
    }

    while (iterations < maxIterations) {
      iterations++;
      const sortedDesc = [...employees].sort((a, b) => totalOff[b.id] - totalOff[a.id]);
      const sortedAsc = [...employees].sort((a, b) => totalOff[a.id] - totalOff[b.id]);

      let swapped = false;
      outer: for (const eMax of sortedDesc) {
        for (const eMin of sortedAsc) {
          if (eMax.id === eMin.id) continue;
          if (totalOff[eMax.id] - totalOff[eMin.id] <= 1) break outer;

          let chosenDate = null;
          for (const date of dates) {
            if (
              sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
              statusOn(eMax.id, date) === 'OFF' &&
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCap(eMax.id, date)
            ) {
              chosenDate = date;
              break;
            }
          }

          if (chosenDate) {
            schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
            schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
            totalOff[eMax.id]--;
            totalOff[eMin.id]++;
            swapped = true;
            break outer;
          }
        }
      }
      if (!swapped) break;
    }

    let maxOff = -Infinity;
    let minOff = Infinity;
    for (const emp of employees) {
      maxOff = Math.max(maxOff, totalOff[emp.id]);
      minOff = Math.min(minOff, totalOff[emp.id]);
    }
    if (maxOff - minOff > 1) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `완전한 균형을 맞추지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일 휴무).`,
        employeeIds: []
      });
    }
  }

  return { generateSchedule };
})();
