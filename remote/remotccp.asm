;==============================================================
;  Remote CCP - see specs/Remote CCP Specification.md
;==============================================================
;A minimal CP/M 2.2 service that answers short text commands over
;the console (the same serial line used for interactive typing)
;and performs disk/file operations on the host's behalf.
;
;Deliberately uses BDOS function 6 (Direct Console I/O) for all
;I/O rather than XMODEM.asm's configurable direct-port system -
;this protocol is command/line and hex-text oriented (like typing
;at the CCP), not a raw binary block transfer, so the standard
;console path is simple, small, and already proven reliable by
;every other command this whole toolchain sends to the CCP.
;
;----------------------------------------------------------------
;Wire format decisions not nailed down by the spec text:
;
;- Every command is a line terminated by CR (matching how the CCP
;  itself is driven).
;
;- FG/FP block encoding: 256 uppercase hex chars for the 128 data
;  bytes, followed by 2 more hex chars for a one-byte sum-mod-256
;  checksum (258 hex chars per block, all-hex framing rather than
;  mixing in a raw checksum byte).
;
;- FL's record-count field is 2 hex chars (matching the FG/FP hex
;  framing) rather than a raw byte - a raw 128 (0FFh's neighbour
;  isn't the issue here, but staying all-hex keeps every field in
;  a text stream self-consistent for whatever parses it).
;
;- FL does not trim trailing space padding from the 8.3 name -
;  fields are sent fixed-width (8 chars, '.', 3 chars, '|') to
;  keep the code small; the host trims if it wants to.
;
;- Directory/disk-select "does this drive exist" check (DL) calls
;  the BIOS's SELDSK entry directly for each of A-P, rather than
;  going through BDOS function 14 (Select Disk) - some BDOS builds
;  print "BDOS ERR ON x: SELECT" and wait for a keypress on a bad
;  drive number instead of just returning, which would hang DL
;  until a key arrived on the console. SELDSK returning HL=0000H
;  for a nonexistent drive is part of the standard BIOS interface
;  itself (see the CP/M 2.2 Alteration Guide), so this sidesteps
;  BDOS's own error handling entirely and works the same way across
;  virtually every CP/M 2.2 BIOS.
;==============================================================

	org 100h

;----------------------
;BDOS entry point & functions (named to match the spec)
;----------------------
BDOS		equ	0005h

C_WRITE		equ	2	;E=char to send
C_DIRIO		equ	6	;E=0FFh: poll input (A=0 if none); else output E
S_BDOSVER	equ	12	;returns version in L
DRV_ALLRESET	equ	13
DRV_SET		equ	14	;E=drive 0-15
F_OPEN		equ	15	;DE=FCB
F_CLOSE		equ	16	;DE=FCB
F_SFIRST	equ	17	;DE=FCB
F_SNEXT		equ	18	;DE=FCB
F_DELETE	equ	19	;DE=FCB
F_READ		equ	20	;DE=FCB, A=0 ok/1=EOF
F_WRITE		equ	21	;DE=FCB, A=0 ok
F_MAKE		equ	22	;DE=FCB
DRV_GET		equ	25	;returns drive 0-15 in A
F_DMAOFF	equ	26	;DE=DMA address

CR	equ	0Dh
ACK	equ	06h
NAK	equ	15h
ETX	equ	03h
EOT	equ	04h

;Offset of the SELDSK entry within the 17-entry BIOS jump table
;(BOOT, WBOOT, CONST, CONIN, CONOUT, LIST, PUNCH, READER, HOME,
;SELDSK, ...) - fixed by the standard CP/M 2.2 BIOS layout.
SELDSK_OFS	equ	27

MAXERR	equ	10	;retries before FG/FP give up on a block

;==============================================================
;Startup: reset disks, report BDOS version, then serve commands.
;
;DRV_ALLRESET reselects drive A: as a documented side effect, which
;would silently undo whatever drive the host had already selected
;via the CCP before launching this program (e.g. "E:" then
;REMOTCCP) - the current drive is saved beforehand and restored
;after so a launch on a non-A drive doesn't desync from it before
;the command loop even starts.
;==============================================================
START:	ld	c,DRV_GET
	call	BDOS
	ld	e,a
	push	de
	ld	c,DRV_ALLRESET
	call	BDOS
	pop	de
	ld	c,DRV_SET
	call	BDOS
	ld	c,S_BDOSVER
	call	BDOS
	ld	a,l
	call	SNDBYT

;The warm-boot vector at 0001H points at the BIOS jump table's
;second entry (BOOT is the first, at BIOSBASE+0) - subtracting 3
;gives the table's start, needed to reach SELDSK directly for DL.
	ld	hl,(1)
	ld	de,3
	or	a
	sbc	hl,de
	ld	(BIOSBASE),hl

;--------------------------------------------------------------
;Main command loop - read a CR-terminated line, dispatch on its
;first (and where needed second) byte.
;--------------------------------------------------------------
MLOOP:	call	RDLINE
	ld	hl,CMDBUF
	ld	a,(hl)
	cp	'Q'
	jp	z,DOQUIT
	cp	'D'
	jp	z,DO_D
	cp	'F'
	jp	z,DO_F
	jp	MLOOP		;unrecognised - ignore, wait for next line

DOQUIT:	ld	a,ACK
	call	SNDBYT
	jp	0		;back to CCP (warm boot)

DO_D:	inc	hl
	ld	a,(hl)
	cp	'C'
	jp	z,DO_DC
	cp	'G'
	jp	z,DO_DG
	cp	'L'
	jp	z,DO_DL
	cp	'S'
	jp	z,DO_DS
	jp	MLOOP

DO_F:	inc	hl
	ld	a,(hl)
	cp	'L'
	jp	z,DO_FL
	cp	'G'
	jp	z,DO_FG
	cp	'P'
	jp	z,DO_FP
	jp	MLOOP

;--------------------------------------------------------------
;DC - current drive, as a letter, then EOT
;--------------------------------------------------------------
DO_DC:	ld	c,DRV_GET
	call	BDOS
	add	a,'A'
	call	SNDBYT
	ld	a,EOT
	call	SNDBYT
	jp	MLOOP

;--------------------------------------------------------------
;DG - current drive, as a letter (no terminator)
;--------------------------------------------------------------
DO_DG:	ld	c,DRV_GET
	call	BDOS
	add	a,'A'
	call	SNDBYT
	jp	MLOOP

;--------------------------------------------------------------
;DS<letter> - set drive. DRV_SET can involve real disk I/O
;(mounting/seeking) that takes a while, so an ACK is sent once it's
;done - the host must wait for it before sending its next command,
;rather than guessing how long the select takes and racing it.
;
;A DRV_GET is issued (and discarded) between DRV_SET and the ACK
;rather than sending the ACK straight after DRV_SET returns - on
;real hardware, a console-output call placed immediately after a
;real disk select has been observed to silently lose its output
;(the select itself still takes effect, but no ACK byte ever
;reaches the host), while DRV_SET followed by any other BDOS call
;before touching the console has not shown this. DL's own per-drive
;loop happens to have this shape already (DRV_SET, DRV_GET, then
;SNDBYT only on a match), which is likely why it's never hit this.
;--------------------------------------------------------------
DO_DS:	inc	hl
	ld	a,(hl)
	sub	'A'
	ld	e,a
	ld	c,DRV_SET
	call	BDOS
	ld	c,DRV_GET
	call	BDOS
	ld	a,ACK
	call	SNDBYT
	jp	MLOOP

;--------------------------------------------------------------
;DL - drive list: call the BIOS's SELDSK entry directly for each
;of A-P and keep only the ones where it returns a non-zero DPH
;address (HL=0000H means the drive doesn't exist) - see the header
;comment for why this goes straight to the BIOS instead of through
;BDOS function 14. BDOS's own notion of the current drive is never
;touched by these probes, but ORIGDRV/restoring it afterward is
;kept anyway as a safety net for BIOSes that mirror SELDSK's result
;back into BDOS state.
;--------------------------------------------------------------
DO_DL:	ld	c,DRV_GET
	call	BDOS
	ld	(ORIGDRV),a
	xor	a
	ld	(DRVIDX),a
DSC_LP:	ld	a,(DRVIDX)
	ld	c,a		;C = drive number for SELDSK
	ld	hl,(BIOSBASE)
	ld	de,SELDSK_OFS
	add	hl,de		;HL -> SELDSK's jump-table entry
	ld	de,0		;E=0: tell the BIOS to re-verify the media
	call	CALLHL		;-> HL = DPH address, or 0000H if no such drive
	ld	a,h
	or	l
	jp	z,DSC_NEXT
	ld	a,(DRVIDX)
	add	a,'A'
	call	SNDBYT
DSC_NEXT:	ld	a,(DRVIDX)
	inc	a
	ld	(DRVIDX),a
	cp	16
	jp	c,DSC_LP
	ld	a,(ORIGDRV)
	ld	e,a
	ld	c,DRV_SET
	call	BDOS
	ld	a,EOT
	call	SNDBYT
	jp	MLOOP

;--------------------------------------------------------------
;FL - list files: filename '.' ext '|' record-count(raw byte) '|'
;repeated for every directory entry, then EOT.
;--------------------------------------------------------------
DO_FL:	ld	de,DMABUF
	ld	c,F_DMAOFF
	call	BDOS
	call	FL_WILD
	ld	de,XFCB
	ld	c,F_SFIRST
	call	BDOS
	jp	FL_CHECK
FL_NEXT:	ld	de,XFCB
	ld	c,F_SNEXT
	call	BDOS
FL_CHECK:	cp	0FFh
	jp	z,FL_DONE
	call	FL_ENTRY
	jp	FL_NEXT
FL_DONE:	ld	a,EOT
	call	SNDBYT
	jp	MLOOP

;fills XFCB with a "match everything" wildcard pattern: '*' as the first
;character of the name and extension fields, '?' filling the rest of each -
;mirrors exactly how the CCP's own command-line parser expands a typed
;"*.*" into an FCB, rather than an FCB of all '?' in every position, which
;hasn't matched reliably on real hardware.
FL_WILD:
	ld 	hl,XFCB
	ld  (hl),0
	inc hl				; -> name field
	ld  b,11			; ???????.???		- we don't need to provide the dot
	FLW_NM:	ld	(hl),'?'
	inc	hl
	djnz	FLW_NM
	ld  b, 24			; remaining FCB length, clear it
FLW_LP:
	ld	(hl),0
	inc	hl
	djnz	FLW_LP
	ret

;A = directory slot (0-3) returned by F_SFIRST/F_SNEXT; prints
;the entry at DMABUF+slot*32
FL_ENTRY:	add	a,a
	add	a,a
	add	a,a
	add	a,a
	add	a,a		;a = slot*32
	ld	hl,DMABUF
	ld	e,a
	ld	d,0
	add	hl,de
	push	hl
	inc	hl		;-> name field
	ld	b,8
FLE_NM:	ld	a,(hl)
	and	7Fh
	call	SNDBYT
	inc	hl
	djnz	FLE_NM
	ld	a,'.'
	call	SNDBYT
	ld	b,3
FLE_EX:	ld	a,(hl)
	and	7Fh
	call	SNDBYT
	inc	hl
	djnz	FLE_EX
	ld	a,'|'
	call	SNDBYT
	pop	hl
	ld	de,15
	add	hl,de		;-> RC field (entry+15)
	ld	a,(hl)
	call	SNDHEX
	ld	a,'|'
	call	SNDBYT
	ret

;--------------------------------------------------------------
;FG<filename> - send file as 128-byte blocks, each 258 hex chars
;(256 data + 2 checksum). Waits for ACK (next block), NAK
;(resend), or ETX (host abandons) after each block.
;--------------------------------------------------------------
DO_FG:	ld	hl,CMDBUF+2
	ld	de,XFCB
	call	PARSEFN
	ld	de,XFCB
	ld	c,F_SFIRST
	call	BDOS
	cp	0FFh
	jp	z,FG_MISS
	ld	de,XFCB
	ld	c,F_OPEN
	call	BDOS
	cp	0FFh
	jp	z,FG_MISS
	ld	de,DMABUF
	ld	c,F_DMAOFF
	call	BDOS
	xor	a
	ld	(ERRCNT),a
FG_BLK:	ld	de,XFCB
	ld	c,F_READ
	call	BDOS
	or	a
	jp	nz,FG_EOF
	call	FG_SEND
FG_WAIT:	call	RDBYT
	cp	ACK
	jp	z,FG_BLK
	cp	NAK
	jp	z,FG_NAK
	cp	ETX
	jp	z,FG_CLOSE
	jp	FG_WAIT
FG_NAK:	ld	a,(ERRCNT)
	inc	a
	ld	(ERRCNT),a
	cp	MAXERR
	jp	nc,FG_GIVEUP
	call	FG_SEND		;dmabuf still holds this block - resend
	jp	FG_WAIT
FG_GIVEUP:	ld	a,ETX
	call	SNDBYT
	jp	FG_CLOSE
FG_EOF:	ld	a,EOT
	call	SNDBYT
FG_CLOSE:	ld	de,XFCB
	ld	c,F_CLOSE
	call	BDOS
	jp	MLOOP
FG_MISS:	ld	a,EOT		;no such file - report as zero blocks
	call	SNDBYT
	jp	MLOOP

;hex-encodes DMABUF (128 bytes) plus its checksum and sends them
FG_SEND:	call	SUMDMA
	ld	(CHKSUM),a
	ld	hl,DMABUF
	ld	b,128
FGS_LP:	ld	a,(hl)
	call	SNDHEX
	inc	hl
	djnz	FGS_LP
	ld	a,(CHKSUM)
	call	SNDHEX
	ret

;--------------------------------------------------------------
;FP<filename> - receive file: existing file deleted first, then
;a fresh file is written from incoming 258-hex-char blocks until
;EOT (done) or ETX (abandoned by sender).
;
;F_DELETE/F_MAKE are real disk I/O and can take a while, so an ACK
;is sent once the file is ready - the host must wait for it before
;streaming the first block, rather than guessing how long file
;creation takes and racing it. ETX instead means creation failed
;(e.g. disk/directory full); either way, this is the only response
;before the block loop starts.
;--------------------------------------------------------------
DO_FP:	ld	hl,CMDBUF+2
	ld	de,XFCB
	call	PARSEFN
	ld	de,XFCB
	ld	c,F_DELETE
	call	BDOS
	ld	de,XFCB
	ld	c,F_MAKE
	call	BDOS
	cp	0FFh
	jp	nz,FP_READY
	ld	a,ETX		;couldn't create the file - host should abort
	call	SNDBYT
	jp	FP_DONE
FP_READY:	ld	a,ACK		;file created - safe to start sending blocks
	call	SNDBYT
	ld	de,DMABUF
	ld	c,F_DMAOFF
	call	BDOS
	xor	a
	ld	(ERRCNT),a
FP_RECV:	call	RDBYT
	cp	EOT
	jp	z,FP_CLOSE
	cp	ETX
	jp	z,FP_CLOSE
	call	FP_BLOCK	;a already holds the block's first hex char
	jp	c,FP_BAD
	ld	de,XFCB
	ld	c,F_WRITE
	call	BDOS
	or	a
	jp	nz,FP_WERR
	ld	a,ACK
	call	SNDBYT
	jp	FP_RECV
FP_BAD:	ld	a,(ERRCNT)
	inc	a
	ld	(ERRCNT),a
	cp	MAXERR
	jp	nc,FP_GIVEUP
	ld	a,NAK
	call	SNDBYT
	jp	FP_RECV
FP_GIVEUP:
FP_WERR:	ld	a,ETX
	call	SNDBYT
FP_CLOSE:	ld	de,XFCB
	ld	c,F_CLOSE
	call	BDOS
FP_DONE:	jp	MLOOP

;Decodes one 258-hex-char block into DMABUF and checks its
;checksum. On entry A = the block's first hex char (already read
;by the caller while peeking for EOT/ETX). Returns carry clear if
;the checksum matched, set otherwise.
FP_BLOCK:	call	HEXVAL
	rlca
	rlca
	rlca
	rlca
	ld	c,a
	call	RDBYT
	call	HEXVAL
	or	c
	ld	hl,DMABUF
	ld	(hl),a
	inc	hl
	ld	b,127
FPB_LP:	call	RDHEXBYTE
	ld	(hl),a
	inc	hl
	djnz	FPB_LP
	call	RDHEXBYTE	;received checksum
	ld	e,a
	call	SUMDMA
	cp	e
	jp	z,FPB_OK
	scf
	ret
FPB_OK:	or	a		;clear carry
	ret

;==============================================================
;Shared helpers
;==============================================================

;checksum (sum mod 256) of DMABUF[0..127] -> A
SUMDMA:	ld	hl,DMABUF
	ld	b,128
	xor	a
SUMD_LP:	add	a,(hl)
	inc	hl
	djnz	SUMD_LP
	ret

;Z80 has no "CALL (HL)" opcode - CALL here pushes the return address,
;then JP (HL) transfers control to HL without touching the stack, so
;the callee's own RET lands back right after the "call CALLHL".
;Used by DO_DL to call the BIOS's SELDSK entry via a computed address.
CALLHL:	jp	(hl)

;sends A as two uppercase hex chars
SNDHEX:	push	af
	rrca
	rrca
	rrca
	rrca
	and	0Fh
	call	HEXDIG
	pop	af
	and	0Fh
	call	HEXDIG
	ret

;A = 0-15 -> sends the matching ASCII hex digit
HEXDIG:	cp	10
	jp	c,HXD_NUM
	add	a,'A'-10
	jp	SNDBYT
HXD_NUM:	add	a,'0'
	jp	SNDBYT

;A = ASCII hex char ('0'-'9','A'-'F') -> A = 0-15
HEXVAL:	sub	'0'
	cp	10
	ret	c
	sub	7
	ret

;reads two hex chars from the link, returns the combined byte in A
RDHEXBYTE:	call	RDBYT
	call	HEXVAL
	rlca
	rlca
	rlca
	rlca
	ld	c,a
	call	RDBYT
	call	HEXVAL
	or	c
	ret

;--------------------------------------------------------------
;Console I/O primitives (BDOS function 6). Preserve BC/DE/HL so
;callers can freely use them as loop counters/pointers around a
;send/receive without extra bookkeeping.
;--------------------------------------------------------------
SNDBYT:	push	bc
	push	de
	push	hl
	ld	e,a
	ld	c,C_DIRIO
	call	BDOS
	pop	hl
	pop	de
	pop	bc
	ret

RDBYT:	push	bc
	push	de
	push	hl
RDB_LP:	ld	e,0FFh
	ld	c,C_DIRIO
	call	BDOS
	or	a
	jp	z,RDB_LP
	pop	hl
	pop	de
	pop	bc
	ret

;reads a CR-terminated command line into CMDBUF. Always leaves a
;CR one byte past whatever was actually read, so a short command
;never sees stale bytes left over from a longer previous one.
RDLINE:	ld	hl,CMDBUF
RDLN_LP:	call	RDBYT
	cp	CR
	jp	z,RDLN_END
	ld	(hl),a
	inc	hl
	jp	RDLN_LP
RDLN_END:	ld	(hl),CR
	ret

;--------------------------------------------------------------
;Parses a CR-terminated "NAME.EXT" filename at HL into the FCB at
;DE (drive defaults to 0/current; name & type space-padded and
;upper-cased).
;--------------------------------------------------------------
PARSEFN:	ex	de,hl
	ld	(FCBSAV),hl
	ex	de,hl
	; zero the whole FCB first - EX/S1/S2/CR/allocation-map bytes
	; matter to F_OPEN/F_READ/F_WRITE and XFCB is reused across
	; commands, so leftover data from a previous FG/FP must not
	; survive into this one.
	push	de
	ld	b,36
	xor	a
PF_ZERO:	ld	(de),a
	inc	de
	djnz	PF_ZERO
	pop	de
	push	de
	inc	de
	ld	b,11
	ld	a,' '
PF_CLR:	ld	(de),a
	inc	de
	djnz	PF_CLR
	pop	de
	inc	de		;-> FCB+1 (name)
	ld	b,8
PF_NM:	ld	a,(hl)
	cp	CR
	jp	z,PF_RET
	cp	'.'
	jp	z,PF_EXT
	call	PF_UP
	ld	(de),a
	inc	de
	inc	hl
	djnz	PF_NM
PF_SKNM:	ld	a,(hl)
	cp	CR
	jp	z,PF_RET
	cp	'.'
	jp	z,PF_EXT
	inc	hl
	jp	PF_SKNM
PF_EXT:	inc	hl		;skip '.'
	push	hl
	ld	hl,(FCBSAV)
	ld	de,9
	add	hl,de
	ex	de,hl		;de = fcb+9
	pop	hl
	ld	b,3
PF_EX2:	ld	a,(hl)
	cp	CR
	jp	z,PF_RET
	call	PF_UP
	ld	(de),a
	inc	de
	inc	hl
	djnz	PF_EX2
PF_RET:	ret

;lower-case letter in A -> upper-case; leaves other chars alone
PF_UP:	cp	'a'
	ret	c
	cp	'z'+1
	ret	nc
	and	5Fh
	ret

;==============================================================
;Data
;==============================================================
DRVIDX:	ds	1
ORIGDRV:	ds	1
CHKSUM:	ds	1
ERRCNT:	ds	1
FCBSAV:	ds	2
BIOSBASE:	ds	2

CMDBUF:	ds	40
XFCB:	ds	36
DMABUF:	ds	128

	end
